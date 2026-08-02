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
include "../backend/configuration.php";

header("Content-Type: application/vnd.dvb.ait+xml;charset=utf-8");

// orgId/appId are allocated by DVB (ETSI TS 101 162). These are placeholder
// values for the thesis prototype and are not registered.
$org_id = 1001;
$app_id = 1;

$interpreter_url = $install_location . "/stream/live/combined/stream.mpd";
$url_base = $install_location . "/hbbtv-app/";
$app_location = "index.html?interpreter=" . $interpreter_url;

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
