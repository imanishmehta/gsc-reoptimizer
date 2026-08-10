<?php

namespace Gsc;

use Google\Client;
use Google\Service\SearchConsole;
use Google\Service\SearchConsole\SearchAnalyticsQueryRequest;
use Google\Service\SearchConsole\InspectUrlIndexRequest;

class GscClient
{
    private SearchConsole $service;

    public function __construct(string $serviceAccountKeyPath)
    {
        $client = new Client();
        $client->setAuthConfig($serviceAccountKeyPath);
        $client->addScope(SearchConsole::WEBMASTERS);
        $this->service = new SearchConsole($client);
    }

    /** @return array<int, array{keys: string[], clicks: float, impressions: float, ctr: float, position: float}> */
    public function query(string $siteUrl, string $startDate, string $endDate, array $dimensions, int $rowLimit = 25000): array
    {
        $request = new SearchAnalyticsQueryRequest([
            'startDate' => $startDate,
            'endDate' => $endDate,
            'dimensions' => $dimensions,
            'rowLimit' => $rowLimit,
        ]);
        $response = $this->service->searchanalytics->query($siteUrl, $request);
        $rows = $response->getRows() ?? [];
        return array_map(fn($r) => [
            'keys' => $r->getKeys(),
            'clicks' => $r->getClicks(),
            'impressions' => $r->getImpressions(),
            'ctr' => $r->getCtr(),
            'position' => $r->getPosition(),
        ], $rows);
    }

    /** Fetch one day of (page, query) rows for a site. */
    public function fetchDay(string $siteUrl, string $date): array
    {
        return $this->query($siteUrl, $date, $date, ['page', 'query'], 25000);
    }

    public function inspectUrl(string $siteUrl, string $inspectionUrl): array
    {
        $request = new InspectUrlIndexRequest([
            'inspectionUrl' => $inspectionUrl,
            'siteUrl' => $siteUrl,
        ]);
        $result = $this->service->urlInspection_index->inspect($request);
        $indexResult = $result->getInspectionResult()->getIndexStatusResult();
        return [
            'verdict' => $indexResult->getVerdict(),
            'coverageState' => $indexResult->getCoverageState(),
        ];
    }
}
