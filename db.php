<?php

function gsc_config(): array
{
    static $config = null;
    if ($config === null) {
        $path = __DIR__ . '/config.php';
        if (!file_exists($path)) {
            fwrite(STDERR, "Missing config.php -- copy config.example.php to config.php and fill it in.\n");
            exit(1);
        }
        $config = require $path;
    }
    return $config;
}

function gsc_db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $db = gsc_config()['db'];
        $pdo = new PDO($db['dsn'], $db['user'], $db['pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    }
    return $pdo;
}
