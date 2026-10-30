<?php
//
// XML AIT for the accessibility interpreter application.
//
// Referenced from backend/servicelists/thesis.xml as the MediaUri of a
// LinkedApplicationCS:2019:1.1 ("app with media in parallel") RelatedMaterial.
// DVB-I A177 table 7 requires that contentType application/vnd.dvb.ait+xml
// resolves to an XML AIT document, not to the application page itself.
//
// HbbTV 2.0.4 (TS 102 796 v1.7.1) annex O: for DVB-I service instances
// delivered by DVB-DASH, the broadcast AIT is replaced by this XML AIT.
// The same content compiles to MPEG-2 sections (e.g. with TSDuck) if the
// service is later also delivered over DVB-T.
//
// The application is launched interpreter-only: the terminal presents the
// main stream from DASHDeliveryParameters, the application adds just the
// signer overlay.
//
// ?service=<UniqueIdentifier> selects which service the AIT is for, and the
// stream is read from that service's own entry in the service list. This is
// what lets one application serve any number of channels: the signer is an
// AdaptationSet with Role="sign" inside each service's own manifest, so the
// application never needs to know which channel it is on — only which manifest
// the service is presenting, which is exactly what the AIT tells it. Add a
// signed channel by adding a Service to the list; nothing here changes.
//
// The service list stays the single source of truth for both the media and the
// application parameters, so the two cannot drift apart.
//
include "../backend/configuration.php";

$SERVICE_LIST = __DIR__ . "/../backend/servicelists/thesis.xml";

// orgId/appId are allocated by DVB (ETSI TS 101 162). These are placeholder
// values for the thesis prototype and are not registered.
//
// They are deliberately the same for every service: this is one application,
// signalled on several services with different parameters, not several
// applications. serviceBound=true then means the terminal tears it down and
// restarts it with the next service's stream on a channel change.
$org_id = 1001;
$app_id = 1;

// The DASH manifest a given service presents.
//
// Prefers the ServiceInstance that links to this AIT, so that a service which
// also offers other instances — a burnt-in signer, say — still hands the
// application the stream it is actually the overlay for. Falls back to the
// instance the client itself would choose, which is the lowest priority number.
function service_stream_url($file, $service_id) {
    $doc = new DOMDocument();
    libxml_use_internal_errors(true);
    if (!@$doc->load($file)) {
        return null;
    }
    $xp = new DOMXPath($doc);

    // Matched on local name: the service list's namespaces are versioned, and a
    // schema revision must not silently stop the AIT from resolving.
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
        // Serving an AIT for the wrong channel would put one service's signer
        // over another's picture, which is worse than serving no application at
        // all. Fail loudly instead: the terminal gets no app, and the reason is
        // in the access log rather than on screen.
        header("HTTP/1.1 404 Not Found");
        header("Content-Type: text/plain;charset=utf-8");
        echo "No service with that UniqueIdentifier, or it has no DASH stream, "
           . "in backend/servicelists/thesis.xml\n";
        exit;
    }
} else {
    // No ?service=: the original single-channel behaviour, kept so that existing
    // links and hand testing keep working.
    $interpreter_url = $install_location . "/stream/live/prenosniki/stream.mpd";
}

header("Content-Type: application/vnd.dvb.ait+xml;charset=utf-8");

$url_base = $install_location . "/hbbtv-app/";

// Percent-encoded as a query value: a manifest URL carrying its own query
// string would otherwise end the parameter early, and the encoding also makes
// the result free of characters that would need XML escaping below.
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
