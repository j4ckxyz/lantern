import pytest

from lantern.address import candidates, clean, needs_warning


@pytest.mark.parametrize("typed, first", [
    ("hermes.tail1234.ts.net", "https://hermes.tail1234.ts.net"),
    ("  Hermes.Tail1234.ts.net/  ", "https://hermes.tail1234.ts.net"),
    ("https//hermes.example.com", "https://hermes.example.com"),
    ("htps:/hermes.example.com", "https://hermes.example.com"),
    ("HTTPS://Hermes.Example.com/sessions?x=1#top", "https://hermes.example.com"),
    ("https://hermes.example.com/#/chat", "https://hermes.example.com"),
    ("192.168.1.20", "http://192.168.1.20:9119"),
    ("raspberrypi.local", "http://raspberrypi.local:9119"),
    ("homelab", "http://homelab:9119"),
    ("192.168.1.20:8080", "http://192.168.1.20:8080"),
    ("hermes.example.com:443", "https://hermes.example.com"),
    ("http://192.168.1.20", "http://192.168.1.20:9119"),
    ("http://hermes.example.com:9119/", "http://hermes.example.com:9119"),
    ("fd7a:115c:a1e0::5", "https://[fd7a:115c:a1e0::5]"),
    ("100.101.102.103", "https://100.101.102.103"),
    ("https://example.com/hermes", "https://example.com/hermes"),
    ("<https://hermes.example.com>", "https://hermes.example.com"),
])
def test_first_guess(typed, first):
    assert candidates(typed)[0] == first


def test_bare_names_try_the_usual_places():
    assert candidates("hermes.example.com") == [
        "https://hermes.example.com", "http://hermes.example.com:9119", "http://hermes.example.com"]
    assert candidates("192.168.1.20") == [
        "http://192.168.1.20:9119", "https://192.168.1.20", "http://192.168.1.20"]


def test_a_path_we_do_not_know_also_tries_the_root():
    assert candidates("https://example.com/hermes") == ["https://example.com/hermes", "https://example.com"]


@pytest.mark.parametrize("typed, says", [
    ("", "Type the address"),
    ("   ", "Type the address"),
    ("https://ada:pw@hermes.example.com", "Leave the username and password out"),
    ("hermes.example.com:abc", "port"),
    ("not an address!", "does not look like an address"),
])
def test_what_cannot_be_repaired_is_said_plainly(typed, says):
    with pytest.raises(ValueError, match=says):
        clean(typed)


def test_warns_only_for_plain_http_off_this_network():
    assert needs_warning("http://hermes.example.com:9119")
    assert not needs_warning("https://hermes.example.com")
    assert not needs_warning("http://192.168.1.20:9119")
    assert not needs_warning("http://hermes.tail1234.ts.net:9119")
    assert not needs_warning("http://homelab:9119")
