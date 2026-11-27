<?php
include "../backend/configuration.php";

$SERVICE_LIST = __DIR__ . "/../backend/servicelists/thesis.xml";

$org_id = 1001;
$app_id = 1;

function service_stream_url($file, $service_id) {
    $doc = new DOMDocument();
    libxml_use_internal_errors(true);
    if (!@$doc->load($file)) {
        return null;
    }
    $xp = new DOMXPath($doc);

    foreach ($xp->query("//*[local-name()='Service']") as $service) {
        $uid = $xp->query("./*[local-name()='UniqueIdentifier']", $service);
        if (!$uid->length || trim($uid->item(0)->textContent) !== $service_id) {
            continue;
        }

        $fallback = null;
        $fallback_priority = null;
        foreach ($xp->query("./*[local-name()='ServiceInstance']", $service) as $instance) {
            $uri = $xp->query(
                ".//*[local-name()='DASHDeliveryParameters']//*[local-name()='URI']",
                $instance
            );
            if (!$uri->length) {
                continue;
            }
            $url = trim($uri->item(0)->textContent);

            $links_here = $xp->query(
                ".//*[local-name()='MediaUri'][contains(., 'aitx.php')]",
                $instance
            );
            if ($links_here->length) {
                return $url;
            }

            $priority = $instance->getAttribute('priority');
            $priority = ($priority === '') ? PHP_INT_MAX : (int) $priority;
            if ($fallback === null || $priority < $fallback_priority) {
                $fallback = $url;
                $fallback_priority = $priority;
            }
        }
        return $fallback;
    }
    return null;
}

$service_id = isset($_GET['service']) ? trim($_GET['service']) : '';

if ($service_id !== '') {
    $interpreter_url = service_stream_url($SERVICE_LIST, $service_id);
    if ($interpreter_url === null) {
        header("HTTP/1.1 404 Not Found");
        header("Content-Type: text/plain;charset=utf-8");
        echo "No service with that UniqueIdentifier, or it has no DASH stream, "
           . "in backend/servicelists/thesis.xml\n";
        exit;
    }
} else {
    $interpreter_url = $install_location . "/stream/live/prenosniki/stream.mpd";
}

header("Content-Type: application/vnd.dvb.ait+xml;charset=utf-8");

$url_base = $install_location . "/hbbtv-app/";

$app_location = "index.html?interpreter=" . rawurlencode($interpreter_url);

$url_base = htmlspecialchars($url_base, ENT_QUOTES | ENT_XML1, 'UTF-8');

echo "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";

$str = <<<EOD
<mhp:ServiceDiscovery xmlns:mhp="urn:dvb:mhp:2009" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
	<mhp:ApplicationDiscovery DomainName="thesis.local">
		<mhp:ApplicationList>
			<mhp:Application>
				<mhp:appName Language="eng">Sign language interpreter</mhp:appName>
				<mhp:applicationIdentifier>
					<mhp:orgId>$org_id</mhp:orgId>
					<mhp:appId>$app_id</mhp:appId>
				</mhp:applicationIdentifier>
				<mhp:applicationDescriptor>
					<mhp:type>
						<mhp:OtherApp>application/vnd.hbbtv.xhtml+xml</mhp:OtherApp>
					</mhp:type>
					<mhp:controlCode>AUTOSTART</mhp:controlCode>
					<mhp:visibility>VISIBLE_ALL</mhp:visibility>
					<mhp:serviceBound>true</mhp:serviceBound>
					<mhp:priority>1</mhp:priority>
					<mhp:version>01</mhp:version>
					<mhp:mhpVersion>
						<mhp:profile>0</mhp:profile>
						<mhp:versionMajor>1</mhp:versionMajor>
						<mhp:versionMinor>3</mhp:versionMinor>
						<mhp:versionMicro>1</mhp:versionMicro>
					</mhp:mhpVersion>
				</mhp:applicationDescriptor>
				<mhp:applicationTransport xsi:type="mhp:HTTPTransportType">
					<mhp:URLBase>$url_base</mhp:URLBase>
				</mhp:applicationTransport>
				<mhp:applicationLocation>$app_location</mhp:applicationLocation>
			</mhp:Application>
		</mhp:ApplicationList>
	</mhp:ApplicationDiscovery>
</mhp:ServiceDiscovery>
EOD;

echo $str;
?>
