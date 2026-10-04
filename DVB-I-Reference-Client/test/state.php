<?php
/**
 * The current test session, polled by the television every couple of seconds.
 * Open: the television cannot log in. It only reveals the participant code and
 * a counter, and changes nothing.
 */
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
