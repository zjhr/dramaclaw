"""Regression: custom-gateway catalog lookups must not shadow identity matches.

In custom-gateway mode every catalog entry carries the same gatewayModel (the
user's single upstream mapping), so a lookup by the gateway model name must
resolve to the entry that owns that name as its catalogId — not to whichever
entry appears first and happens to share the gatewayModel. Caught live as
seedance-2.0-fast being submitted to the gateway when the canvas video node
selected agnes-video-2.5-flash (freezone omni-gen 503, 2026-09-16).
"""

from novelvideo.api.routes.freezone import _find_catalog_entry

# Mirrors the custom-gateway catalog shape: every seedance entry is stamped
# with the user's upstream (agnes) as gatewayModel, and agnes itself is also
# a catalog entry.
CATALOG = [
    {
        "catalogId": "seedance-2.0-fast",
        "id": "seedance-2.0-fast",
        "apiModel": "newapi_seedance-2.0-fast",
        "gatewayModel": "agnes-video-2.5-flash",
    },
    {
        "catalogId": "seedance-2.0",
        "id": "seedance-2.0",
        "apiModel": "newapi_seedance-2.0",
        "gatewayModel": "agnes-video-2.5-flash",
    },
    {
        "catalogId": "agnes-video-2.5-flash",
        "id": "agnes-video-2.5-flash",
        "apiModel": "newapi_agnes-video-2.5-flash",
        "gatewayModel": "agnes-video-2.5-flash",
    },
]


def test_gateway_model_name_resolves_to_owning_entry():
    entry = _find_catalog_entry(CATALOG, "agnes-video-2.5-flash")
    assert entry is not None
    assert entry["catalogId"] == "agnes-video-2.5-flash"


def test_identity_keys_still_resolve():
    assert _find_catalog_entry(CATALOG, "seedance-2.0-fast")["id"] == "seedance-2.0-fast"
    assert _find_catalog_entry(CATALOG, "newapi_seedance-2.0")["id"] == "seedance-2.0"


def test_gateway_key_fallback_when_no_entry_owns_the_name():
    catalog = [
        {
            "catalogId": "seedance-2.0-fast",
            "apiModel": "newapi_seedance-2.0-fast",
            "gatewayModel": "some-upstream-model",
        }
    ]
    assert _find_catalog_entry(catalog, "some-upstream-model") is not None
    assert _find_catalog_entry(catalog, "unknown-model") is None


def test_empty_catalog_and_request():
    assert _find_catalog_entry(None, "x") is None
    assert _find_catalog_entry(CATALOG, "") is None
