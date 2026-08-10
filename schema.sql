CREATE TABLE IF NOT EXISTS sites (
    id INT PRIMARY KEY AUTO_INCREMENT,
    label VARCHAR(50) NOT NULL,
    gsc_site_url VARCHAR(255) NOT NULL UNIQUE,
    sitemap_url VARCHAR(500) NOT NULL
);

-- one row per (site, day, page, query). Page-level and query-level views
-- are derived from this by GROUP BY -- single source of truth, no duplication.
CREATE TABLE IF NOT EXISTS stats_query_page (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    site_id INT NOT NULL,
    date DATE NOT NULL,
    page VARCHAR(768) NOT NULL,
    query VARCHAR(512) NOT NULL,
    clicks INT NOT NULL DEFAULT 0,
    impressions INT NOT NULL DEFAULT 0,
    ctr DECIMAL(7,4) NOT NULL DEFAULT 0,
    position DECIMAL(6,2) NOT NULL DEFAULT 0,
    UNIQUE KEY uk_row (site_id, date, page(300), query(200)),
    KEY idx_site_date (site_id, date),
    KEY idx_site_page (site_id, page(300)),
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sitemap_urls (
    id INT PRIMARY KEY AUTO_INCREMENT,
    site_id INT NOT NULL,
    url VARCHAR(768) NOT NULL,
    last_seen DATE NOT NULL,
    UNIQUE KEY uk_url (site_id, url(400)),
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

-- cached url inspection results (on-demand, not cron'd -- API is rate limited)
CREATE TABLE IF NOT EXISTS index_inspections (
    id INT PRIMARY KEY AUTO_INCREMENT,
    site_id INT NOT NULL,
    url VARCHAR(768) NOT NULL,
    verdict VARCHAR(50),
    coverage_state VARCHAR(255),
    checked_at DATETIME NOT NULL,
    UNIQUE KEY uk_inspect (site_id, url(400)),
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

-- sitemap_url points at the sitemap INDEX (both properties use one) --
-- fetch_sitemaps.php resolves the index into its child sitemaps automatically.
INSERT INTO sites (label, gsc_site_url, sitemap_url) VALUES
    ('mimicminds', 'sc-domain:mimicminds.com', 'https://www.mimicminds.com/sitemap.xml'),
    ('mimicproductions', 'https://www.mimicproductions.com/', 'https://www.mimicproductions.com/sitemap.xml')
ON DUPLICATE KEY UPDATE label = VALUES(label);
