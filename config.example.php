<?php
return [
    'db' => [
        'dsn'  => 'mysql:host=localhost;dbname=gsc_reoptimizer;charset=utf8mb4',
        'user' => 'db_user',
        'pass' => 'db_pass',
    ],
    // Google Cloud service account JSON key file. Create it in GCP Console,
    // enable the "Google Search Console API", then add the service account's
    // email as a user on each property (Search Console -> Settings -> Users
    // and permissions -> Add user -> Restricted is enough for read + inspect).
    'service_account_key' => __DIR__ . '/service-account.json',

    // shared password for public/ dashboard (see public/.htaccess.example)
    'dashboard_password_hash' => '', // php -r "echo password_hash('yourpass', PASSWORD_DEFAULT);"
];
