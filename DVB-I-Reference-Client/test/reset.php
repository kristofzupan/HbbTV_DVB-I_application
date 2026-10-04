<?php
/**
 * The three control-page actions, all of which change state.json:
 *
 *   action=start    New participant: ends the running session, starts a new one
 *                   under the given code, and restarts every stream.
 *   action=restart  Restarts every stream and reloads the television, without
 *                   touching the session — for setting up, or a fresh start.
 *   action=end      Ends the running session. Nothing restarts; from the next
 *                   poll the television logs to the unassigned log, so what
 *                   happens between participants is in nobody's results.
 *
 * A restart is the counter and the reset time: the publisher picks the time up
 * within half a second and plays every loop from its start again; televisions
 * see the counter change on their next poll and reload.
 */
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

// Marks the running session as ended in the index, if there is one.
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
    // Sortable, readable, and unique for any realistic pace of testing.
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

// The index first: log.php only accepts sessions the index knows, and a
// television can poll the new state and send its first event within moments.
write_json(INDEX_FILE, $index);
write_json(STATE_FILE, $state);

header('Location: index.php?done=' . urlencode($action));
