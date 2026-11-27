<?php
require __DIR__ . '/common.php';

no_cache();
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$state = current_state();
echo json_encode([
    'counter' => (int) $state['counter'],
    'session' => (string) $state['session'],
    'participant' => (string) $state['participant'],
]);
