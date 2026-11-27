<?php
require __DIR__ . '/common.php';

no_cache();
header('Access-Control-Allow-Origin: *');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    header('Access-Control-Allow-Methods: POST');
    header('Access-Control-Allow-Headers: Content-Type');
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit;
}

$raw = file_get_contents('php://input', false, null, 0, 1024 * 1024);
$events = json_decode($raw, true);
if (!is_array($events)) {
    http_response_code(400);
    exit;
}

ensure_data_dirs();
$known = array_column(sessions_index(), 'id');
$now = (int) round(microtime(true) * 1000);

$lines = [];
foreach ($events as $e) {
    if (!is_array($e)) continue;
    $session = clean_id($e['session'] ?? '');
    if (!in_array($session, $known, true)) $session = UNASSIGNED;
    $e['session'] = $session;
    $e['received'] = $now;
    $lines[$session][] = json_encode($e, JSON_UNESCAPED_UNICODE);
}

foreach ($lines as $session => $batch) {
    file_put_contents(session_file($session), implode("\n", $batch) . "\n", FILE_APPEND | LOCK_EX);
}

header('Content-Type: application/json');
echo json_encode(['ok' => true]);
