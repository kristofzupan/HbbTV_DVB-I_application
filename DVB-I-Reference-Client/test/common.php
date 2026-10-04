<?php
/**
 * Shared by the test-session endpoints in this directory.
 *
 * A test session is one participant in front of the television. The control
 * page (index.php) starts one with a participant code; that does two things at
 * once, so there is only one "reset" to think about:
 *
 *   - state.json gets a new session and a new reset time. The publisher reads
 *     the reset time and restarts every channel's loop from it, so every
 *     participant sees the same programme from the same point.
 *   - The client on the television polls state.php, sees the counter change and
 *     reloads itself: channel 1, application in its default state.
 *
 * Everything the television does from then on is sent to log.php and appended
 * to that session's log; report.php turns the logs into CSV.
 *
 * Data lives in test-data/ at the repository root, outside the document root,
 * so the logs are reachable only through report.php.
 */

// Deliberately simple: this protects a test rig on a lab network from being
// reset by accident, not from an attacker. The worst anyone could do with it is
// restart the streams or read participant codes and key presses.
const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'admin123';

// Times in the reports are read by people in the lab, not compared across zones.
date_default_timezone_set('Europe/Ljubljana');

define('DATA_DIR', dirname(__DIR__, 2) . '/test-data');
define('SESSIONS_DIR', DATA_DIR . '/sessions');
define('STATE_FILE', DATA_DIR . '/state.json');
define('INDEX_FILE', DATA_DIR . '/sessions.json');

// Events logged before the first session is started, or by a television whose
// session has since been replaced, still have to go somewhere readable.
const UNASSIGNED = 'unassigned';

function ensure_data_dirs()
{
    foreach ([DATA_DIR, SESSIONS_DIR] as $dir) {
        if (!is_dir($dir) && !@mkdir($dir, 0775, true)) {
            http_response_code(500);
            header('Content-Type: text/plain');
            echo "Cannot create $dir — on a server it has to be writable by the PHP user.\n";
            exit;
        }
    }
}

function read_json($file, $default)
{
    $raw = @file_get_contents($file);
    if ($raw === false) return $default;
    $data = json_decode($raw, true);
    return is_array($data) ? $data : $default;
}

// Written to a temporary file and renamed, so the publisher, which reads the
// state every half second, never sees a half-written document.
function write_json($file, $data)
{
    $tmp = $file . '.tmp' . getmypid();
    file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n");
    rename($tmp, $file);
}

function current_state()
{
    return read_json(STATE_FILE, ['counter' => 0, 'session' => '', 'participant' => '', 'resetAt' => 0]);
}

function sessions_index()
{
    return read_json(INDEX_FILE, []);
}

// Session ids become file names, so only a conservative alphabet gets through.
function clean_id($s)
{
    return preg_replace('/[^A-Za-z0-9_-]/', '', (string) $s);
}

function session_file($id)
{
    $id = clean_id($id);
    return SESSIONS_DIR . '/' . ($id === '' ? UNASSIGNED : $id) . '.jsonl';
}

function start_login_session()
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        session_name('dvbi_test');
        session_start();
    }
}

function is_logged_in()
{
    start_login_session();
    return !empty($_SESSION['test_admin']);
}

// For the endpoints the control page calls; the page itself shows a form.
function require_login()
{
    if (!is_logged_in()) {
        http_response_code(401);
        header('Content-Type: text/plain');
        echo "Not logged in.\n";
        exit;
    }
}

function no_cache()
{
    header('Cache-Control: no-store');
}
