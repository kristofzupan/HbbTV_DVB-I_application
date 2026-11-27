<?php

const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'admin123';

date_default_timezone_set('Europe/Ljubljana');

define('DATA_DIR', dirname(__DIR__, 2) . '/test-data');
define('SESSIONS_DIR', DATA_DIR . '/sessions');
define('STATE_FILE', DATA_DIR . '/state.json');
define('INDEX_FILE', DATA_DIR . '/sessions.json');

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
