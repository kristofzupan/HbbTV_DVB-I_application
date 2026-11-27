<?php
require __DIR__ . '/common.php';

require_login();
no_cache();

const TV_FIELDS = ['channel', 'channel_name', 'subtitles'];
const APP_FIELDS = ['signer', 'view', 'position', 'signer_size_pct'];

const PASSIVE = ['page_loaded', 'auto_tuned', 'still_watching', 'left_app',
                 'restart_received', 'returned_to_app', 'app_opened'];
const NO_EFFECT = ['size_limit_reached', 'move_limit_reached',
                   'move_not_possible_in_split_view', 'ignored_signer_off', 'ok_pressed'];
const COUNTED = [
    'channel_changed' => 'times_channel_changed',
    'subtitles_on' => 'times_subtitles_switched',
    'subtitles_off' => 'times_subtitles_switched',
    'signer_on' => 'times_signer_switched',
    'signer_off' => 'times_signer_switched',
    'view_changed' => 'times_view_changed',
    'signer_moved' => 'times_moved',
    'signer_smaller' => 'times_resized',
    'signer_larger' => 'times_resized',
];
const COUNTERS = ['times_channel_changed', 'times_subtitles_switched', 'times_signer_switched',
                  'times_view_changed', 'times_moved', 'times_resized'];
const DIMENSIONS = ['channel', 'subtitles', 'signer', 'view', 'position', 'signer_size'];

const MAX_INTERVAL_MS = 40000;

$type = $_GET['type'] ?? 'events';
$which = clean_id($_GET['session'] ?? 'all');

$sessions = [];
foreach (sessions_index() as $s) {
    if ($which === 'all' || $which === $s['id']) $sessions[] = $s;
}
if (!$sessions) {
    http_response_code(404);
    header('Content-Type: text/plain');
    echo "No such session.\n";
    exit;
}

function load_events($id)
{
    $events = [];
    $fh = @fopen(session_file($id), 'r');
    if (!$fh) return $events;
    while (($line = fgets($fh)) !== false) {
        $e = json_decode($line, true);
        if (is_array($e) && isset($e['t'])) $events[] = $e;
    }
    fclose($fh);
    usort($events, function ($a, $b) {
        return $a['t'] <=> $b['t'];
    });
    return $events;
}

function source_of($e)
{
    $s = $e['source'] ?? '';
    return $s === 'client' ? 'tv' : ($s === 'app' ? 'signer_app' : $s);
}

function fmt($v)
{
    if ($v === null) return '';
    if ($v === true) return 'on';
    if ($v === false) return 'off';
    return (string) $v;
}

function replay($events, $each)
{
    $st = array_fill_keys(array_merge(TV_FIELDS, APP_FIELDS), null);
    foreach ($events as $e) {
        $in = is_array($e['state'] ?? null) ? $e['state'] : [];
        if (source_of($e) === 'tv') {
            $before = $st['channel'];
            foreach (TV_FIELDS as $f) {
                if (array_key_exists($f, $in)) $st[$f] = $in[$f];
            }
            if ($st['channel'] !== $before) {
                foreach (APP_FIELDS as $f) $st[$f] = null;
            }
        } else {
            foreach (APP_FIELDS as $f) {
                if (array_key_exists($f, $in)) $st[$f] = $in[$f];
            }
        }
        $each($e, $st);
    }
}

function value_of($st, $dim)
{
    switch ($dim) {
        case 'channel':
            return $st['channel'] === null ? null : (string) $st['channel'];
        case 'subtitles':
            return $st['subtitles'] === null ? null : fmt($st['subtitles']);
        case 'signer':
            return $st['signer'] === null ? null : fmt($st['signer']);
        case 'view':
            return $st['signer'] === true ? $st['view'] : null;
        case 'position':
            return $st['signer'] === true ? $st['position'] : null;
        case 'signer_size':
            return $st['signer'] === true && $st['signer_size_pct'] !== null
                ? $st['signer_size_pct'] . 'pct' : null;
    }
    return null;
}

function csv_row($out, $row)
{
    fputcsv($out, $row, ',', '"', '');
}

function type_of($events)
{
    foreach ($events as $e) {
        if (!empty($e['deviceType'])) return $e['deviceType'];
    }
    return '';
}

function by_device($events)
{
    $by = [];
    foreach ($events as $e) $by[$e['device'] ?? ''][] = $e;
    return $by;
}

$out = fopen('php://output', 'w');
header('Content-Type: text/csv; charset=utf-8');
$name = ($which === 'all' ? 'all-sessions' : $which) . '-' . $type . '.csv';
header('Content-Disposition: attachment; filename="' . $name . '"');
fwrite($out, "\xEF\xBB\xBF");

if ($type === 'events') {
    csv_row($out, array_merge(
        ['session', 'participant', 'device', 'device_type', 'time', 'seconds_into_session', 'from', 'action', 'key'],
        TV_FIELDS, APP_FIELDS
    ));
    foreach ($sessions as $s) {
        foreach (by_device(load_events($s['id'])) as $device => $events) {
            $dtype = type_of($events);
            replay($events, function ($e, $st) use ($out, $s, $device, $dtype) {
                $row = [
                    $s['id'], $s['participant'], $device, $dtype,
                    date('Y-m-d H:i:s', (int) ($e['t'] / 1000)) . sprintf('.%03d', $e['t'] % 1000),
                    sprintf('%.1f', ($e['t'] - $s['startedAt']) / 1000),
                    source_of($e), $e['action'] ?? '', $e['key'] ?? '',
                ];
                foreach (array_merge(TV_FIELDS, APP_FIELDS) as $f) $row[] = fmt($st[$f]);
                csv_row($out, $row);
            });
        }
    }
    exit;
}

$rows = [];
$columns = [];
foreach ($sessions as $s) {
    foreach (by_device(load_events($s['id'])) as $device => $events) {
        $r = [
            's' => $s, 'device' => $device, 'type' => type_of($events), 'time' => [], 'watched' => 0,
            'presses' => 0, 'no_effect' => 0, 'first_press' => null,
            'counts' => array_fill_keys(COUNTERS, 0), 'final' => null,
        ];
        $prev = null;

        replay($events, function ($e, $st) use (&$r, &$prev, &$columns, $s) {
            $action = $e['action'] ?? '';
            if (!in_array($action, PASSIVE, true)) {
                $r['presses']++;
                if ($r['first_press'] === null) $r['first_press'] = $e['t'] - $s['startedAt'];
            }
            if (in_array($action, NO_EFFECT, true)) $r['no_effect']++;
            if (isset(COUNTED[$action])) $r['counts'][COUNTED[$action]]++;

            if ($prev !== null) {
                list($pt, $pst, $paction) = $prev;
                $dt = $paction === 'left_app' ? 0 : min($e['t'] - $pt, MAX_INTERVAL_MS);
                $r['watched'] += $dt;
                foreach (DIMENSIONS as $d) {
                    $v = value_of($pst, $d);
                    if ($v === null) continue;
                    $r['time'][$d][$v] = ($r['time'][$d][$v] ?? 0) + $dt;
                    $columns[$d][$v] = true;
                }
            }
            $prev = [$e['t'], $st, $action];
            $r['final'] = $st;
        });

        $rows[] = $r;
    }
}

foreach ($columns as $d => $vals) {
    ksort($columns[$d], SORT_NATURAL);
}

$header = ['session', 'participant', 'device', 'device_type', 'started', 'watched_seconds',
           'button_presses', 'presses_without_effect', 'seconds_to_first_press'];
$header = array_merge($header, COUNTERS);
foreach (DIMENSIONS as $d) $header[] = 'at_end_' . $d;
foreach (DIMENSIONS as $d) {
    foreach (array_keys($columns[$d] ?? []) as $v) $header[] = 'seconds_' . $d . '_' . $v;
}
csv_row($out, $header);

foreach ($rows as $r) {
    $row = [
        $r['s']['id'], $r['s']['participant'], $r['device'], $r['type'],
        date('Y-m-d H:i:s', (int) ($r['s']['startedAt'] / 1000)),
        sprintf('%.1f', $r['watched'] / 1000),
        $r['presses'], $r['no_effect'],
        $r['first_press'] === null ? '' : sprintf('%.1f', $r['first_press'] / 1000),
    ];
    foreach (COUNTERS as $c) $row[] = $r['counts'][$c];
    foreach (DIMENSIONS as $d) $row[] = $r['final'] ? (string) value_of($r['final'], $d) : '';
    foreach (DIMENSIONS as $d) {
        foreach (array_keys($columns[$d] ?? []) as $v) {
            $row[] = sprintf('%.1f', ($r['time'][$d][$v] ?? 0) / 1000);
        }
    }
    csv_row($out, $row);
}
