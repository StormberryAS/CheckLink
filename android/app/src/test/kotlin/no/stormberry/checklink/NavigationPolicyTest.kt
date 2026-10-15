package no.stormberry.checklink

import no.stormberry.checklink.NavigationPolicy.Decision.BLOCK
import no.stormberry.checklink.NavigationPolicy.Decision.EXTERNAL
import no.stormberry.checklink.NavigationPolicy.Decision.EXTERNAL_APP
import no.stormberry.checklink.NavigationPolicy.Decision.IN_APP
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigationPolicyTest {
    @Test fun theBundledAppLoadsInPlace() {
        assertEquals(IN_APP, NavigationPolicy.decide("https://appassets.androidplatform.net/index.html"))
        assertEquals(IN_APP, NavigationPolicy.decide("https://appassets.androidplatform.net/"))
        assertEquals(IN_APP, NavigationPolicy.decide("https://appassets.androidplatform.net/disclaimer.html#top"))
        assertEquals(IN_APP, NavigationPolicy.decide("https://APPASSETS.androidplatform.net/app.js?v=1"))
        assertEquals(IN_APP, NavigationPolicy.decide("https://appassets.androidplatform.net:443/index.html"))
    }

    /**
     * Stage 5: the footer's Privacy and Disclaimer, the notice's "Read the full disclaimer" and the
     * pages' "Back to CheckLink" (./) stay inside the app; the links out of those pages (the
     * company privacy policy, Datatilsynet, the repository, the register) open in the browser,
     * and the email address in the mail app.
     */
    @Test fun theLegalPagesOpenInPlaceAndTheirOutsideLinksLeave() {
        assertEquals(IN_APP, NavigationPolicy.decide("https://appassets.androidplatform.net/privacy.html"))
        assertEquals(IN_APP, NavigationPolicy.decide("https://appassets.androidplatform.net/disclaimer.html"))
        assertEquals(IN_APP, NavigationPolicy.decide("https://appassets.androidplatform.net/"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://stormberry.as/privacy"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://www.datatilsynet.no"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://github.com/StormberryAS/CheckLink/commits/main/privacy.html"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://virksomhet.brreg.no/nb/oppslag/enheter/937751249"))
        assertEquals(EXTERNAL_APP, NavigationPolicy.decide("mailto:info@stormberry.as"))
    }

    @Test fun theAssetHostIsOnlyTrustedOverHttpsOnItsOwnPort() {
        assertEquals(BLOCK, NavigationPolicy.decide("http://appassets.androidplatform.net/index.html"))
        assertEquals(BLOCK, NavigationPolicy.decide("https://appassets.androidplatform.net:8443/index.html"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://appassets.androidplatform.net.evil.example/"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://evil.example/appassets.androidplatform.net/"))
    }

    @Test fun otherWebAddressesOpenInTheBrowser() {
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://stormberry.as/labs.html"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://username.stormberry.as"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://zapstore.dev/apps/x"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("http://example.com/"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://virksomhet.brreg.no/nb/oppslag/enheter/937751249"))
    }

    @Test fun everyOtherSchemeIsRefused() {
        listOf(
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "intent://scan/#Intent;scheme=zxing;package=com.example;end",
            "file:///data/data/no.stormberry.checklink/shared_prefs/x.xml",
            "content://media/external/images/media/1",
            "data:text/html,<script>alert(1)</script>",
            "blob:https://appassets.androidplatform.net/1234",
            "about:blank",
            "ftp://example.com/",
            "market://details?id=x",
        ).forEach { assertEquals(it, BLOCK, NavigationPolicy.decide(it)) }
    }

    @Test fun mailAndNostrLinksGoToAnotherApp() {
        assertEquals(EXTERNAL_APP, NavigationPolicy.decide("mailto:info@stormberry.as"))
        assertEquals(EXTERNAL_APP, NavigationPolicy.decide("MAILTO:info@stormberry.as?subject=Hello"))
        assertEquals(
            EXTERNAL_APP,
            NavigationPolicy.decide("nostr:npub1zz9w77p2jkn95t0st9tcuea8zdn2vknf0ctrwyd4g46w3kswdccqesr0pa"),
        )
    }

    @Test fun mailAndNostrOnlyInTheirPlainForm() {
        assertEquals(BLOCK, NavigationPolicy.decide("mailto:"))
        assertEquals(BLOCK, NavigationPolicy.decide("nostr:"))
        assertEquals(BLOCK, NavigationPolicy.decide("mailto://evil.example/x"))
        assertEquals(BLOCK, NavigationPolicy.decide("nostr:/npub1x"))
        assertEquals(BLOCK, NavigationPolicy.decide("nostr:npub 1x"))
    }

    @Test fun hostsWithAnUnderscoreOpenInTheBrowser() {
        // java.net.URI gives no host for these; browsers open them.
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://a_b.example/"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://my_shop.example.com:8443/p?id=7"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("http://_dmarc.example.com/"))
        assertTrue(NavigationPolicy.isWebAddressToOpen("https://a_b.example/x"))
        // Only a plain name and port: anything else in such an authority is refused.
        assertEquals(BLOCK, NavigationPolicy.decide("https://user@a_b.example/"))
        assertEquals(BLOCK, NavigationPolicy.decide("https://a_b.example:99999/"))
        assertEquals(BLOCK, NavigationPolicy.decide("https://a_b.example:/"))
        assertEquals(BLOCK, NavigationPolicy.decide("https://a_b.example:x/"))
        assertEquals(BLOCK, NavigationPolicy.decide("https://_/"))
        assertEquals(BLOCK, NavigationPolicy.decide("https://a_b%2eexample/"))
        assertEquals(BLOCK, NavigationPolicy.decide("javascript://a_b.example/"))
        // Never the app's own host, never in place.
        assertEquals(BLOCK, NavigationPolicy.decide("https://appassets.androidplatform.net:99999/"))
        assertFalse(NavigationPolicy.isAssetRequest("https://a_b.example/app.js"))
    }

    @Test fun malformedAndDeceptiveAddressesAreRefused() {
        assertEquals(BLOCK, NavigationPolicy.decide(null))
        assertEquals(BLOCK, NavigationPolicy.decide(""))
        assertEquals(BLOCK, NavigationPolicy.decide("   "))
        assertEquals(BLOCK, NavigationPolicy.decide("https://"))
        assertEquals(BLOCK, NavigationPolicy.decide("https:///index.html"))
        assertEquals(BLOCK, NavigationPolicy.decide("https://stormberry.as@evil.example/"))
        assertEquals(BLOCK, NavigationPolicy.decide("https://appassets.androidplatform.net\\@evil.example/"))
        assertEquals(BLOCK, NavigationPolicy.decide("index.html"))
    }

    @Test fun requestsOnlyReachTheAssetLoaderFromTheAssetOrigin() {
        assertTrue(NavigationPolicy.isAssetRequest("https://appassets.androidplatform.net/src/qr-worker.js?v=d6f9fb01"))
        assertFalse(NavigationPolicy.isAssetRequest("https://check.stormberry.as/app.js"))
        assertFalse(NavigationPolicy.isAssetRequest("http://appassets.androidplatform.net/app.js"))
    }

    @Test fun messageOrigins() {
        assertTrue(NavigationPolicy.isAssetOrigin("https://appassets.androidplatform.net"))
        assertTrue(NavigationPolicy.isAssetOrigin("https://appassets.androidplatform.net/"))
        assertFalse(NavigationPolicy.isAssetOrigin("http://appassets.androidplatform.net"))
        assertFalse(NavigationPolicy.isAssetOrigin("https://check.stormberry.as"))
        assertFalse(NavigationPolicy.isAssetOrigin("null"))
        assertFalse(NavigationPolicy.isAssetOrigin(null))
    }

    @Test fun goToOpensOnlyWebAddressesOnOtherHosts() {
        assertTrue(NavigationPolicy.isWebAddressToOpen("https://example.com/a?id=2"))
        assertTrue(NavigationPolicy.isWebAddressToOpen("http://example.com/"))
        assertTrue(NavigationPolicy.isWebAddressToOpen("https://xn--bcher-kva.example/"))
        assertFalse(NavigationPolicy.isWebAddressToOpen("https://appassets.androidplatform.net/index.html"))
        assertFalse(NavigationPolicy.isWebAddressToOpen("mailto:info@stormberry.as"))
        assertFalse(NavigationPolicy.isWebAddressToOpen("nostr:npub1zz9w77p2jkn95t0st9tcuea8zdn2vknf0ctrwyd4g46w3kswdccqesr0pa"))
        assertFalse(NavigationPolicy.isWebAddressToOpen("javascript:alert(1)"))
        assertFalse(NavigationPolicy.isWebAddressToOpen("intent://x#Intent;scheme=https;end"))
        assertFalse(NavigationPolicy.isWebAddressToOpen("https://google.com@evil.example/"))
        assertFalse(NavigationPolicy.isWebAddressToOpen("ftp://example.com/"))
        assertFalse(NavigationPolicy.isWebAddressToOpen(null))
    }
}
