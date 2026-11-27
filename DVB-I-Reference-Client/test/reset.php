<?php
require __DIR__ . '/common.php';

require_login();
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit;
}

ensure_data_dirs();

$action = $_POST['action'] ?? 'start';
$now = (int) round(microtime(true) * 1000);
$state = current_state();
$index = sessions_index();

function end_running(&$index, $state, $now)
{
    foreach ($index as &$s) {
        if ($s['id'] === $state['session'] && empty($s['endedAt'])) $s['endedAt'] = $now;
    }
    unset($s);
}

function restart(&$state, $now)
{
    $state['counter'] = (int) $state['counter'] + 1;
    $state['resetAt'] = $now;
}

if ($action === 'start') {
    $participant = clean_id(trim($_POST['participant'] ?? ''));
    if ($participant === '') {
        header('Location: index.php?error=participant');
        exit;
    }
    $id = date('Ymd-His', (int) ($now / 1000)) . '-' . $participant;
    end_running($index, $state, $now);
    $index[] = ['id' => $id, 'participant' => $participant, 'startedAt' => $now];
    $state['session'] = $id;
    $state['participant'] = $participant;
    restart($state, $now);
} elseif ($action === 'restart') {
    restart($state, $now);
} elseif ($action === 'end') {
    end_running($index, $state, $now);
    $state['session'] = '';
    $state['participant'] = '';
} else {
    http_response_code(400);
    exit;
}

write_json(INDEX_FILE, $index);
write_json(STATE_FILE, $state);

header('Location: index.php?done=' . urlencode($action));
