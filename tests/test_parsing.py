"""MEDIA tags, link safety and what gets read aloud: the pure functions."""

from __future__ import annotations

import pytest

from lantern import links, media
from lantern.service import speakable


def test_media_tags_are_taken_out_of_the_text():
    paths, text = media.extract("Here you go.\n\nMEDIA:/home/h/.hermes/cache/images/a.png\n**MEDIA:/tmp/report.pdf**")
    assert paths == [("/home/h/.hermes/cache/images/a.png", False), ("/tmp/report.pdf", False)]
    assert text == "Here you go."


def test_examples_in_code_and_quotes_stay_text():
    reply = "Use it like this: `MEDIA:/x/example.png`\n\n```\nMEDIA:/x/in-a-block.png\n```\n> MEDIA:/x/quoted.png"
    paths, text = media.extract(reply)
    assert paths == []
    assert "MEDIA:/x/example.png" in text and "MEDIA:/x/in-a-block.png" in text


def test_voice_marks_audio_only():
    paths, text = media.extract("[[audio_as_voice]]\nMEDIA:/c/tts.mp3\nMEDIA:/c/pic.png")
    assert paths == [("/c/tts.mp3", True), ("/c/pic.png", False)]
    assert text == ""


def test_unknown_extensions_stay_visible_and_duplicates_count_once():
    paths, text = media.extract("MEDIA:/a/run.log\nMEDIA:/a/b.csv\nagain: MEDIA:/a/b.csv")
    assert paths == [("/a/b.csv", False)]
    assert "MEDIA:/a/run.log" in text


def test_a_tag_being_streamed_never_flashes():
    assert media.displayable("Here it is.\nMEDIA:/home/h/.her") == "Here it is."
    assert media.displayable("Here it is.\nME") == "Here it is."
    assert media.displayable("Media coverage was good") == "Media coverage was good"
    assert media.displayable("Done [[audio_as") == "Done"


def test_media_kinds():
    assert media.kind_of("a.PNG") == "image" and media.kind_of("b.opus") == "audio" and media.kind_of("c.zip") == "file"


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/", "http://localhost:8080/", "http://10.0.0.5/", "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data", "http://100.101.102.103/", "http://[fd7a:115c:a1e0::1]/",
    "http://[::1]/", "file:///etc/passwd", "ftp://example.com/", "http://user:pw@example.com/",
    "http://example.com:22/",
])
def test_private_and_odd_addresses_are_never_fetched(url):
    with pytest.raises(links.Blocked):
        links.check_url(url)
        links._resolve(*links.check_url(url)[1:3])


def test_public_addresses_are_allowed():
    assert links.check_url("https://www.raspberrypi.com/products/?a=1")[1] == "www.raspberrypi.com"
    assert links._public("93.184.215.14") and not links._public("100.64.0.1") and not links._public("::ffff:10.0.0.1")


def test_a_page_becomes_a_preview():
    page = b"""<html><head><meta charset="utf-8"><title>Ignored</title>
    <meta property="og:title" content="Touch Display 2 &amp; more">
    <meta name="description" content="A 5&quot; screen.">
    <meta property="og:image" content="/img/hero.jpg"><link rel="icon" href="/fav.png"></head></html>"""
    preview = links.parse_page("https://www.raspberrypi.com/products/x/", page, "text/html")
    assert preview["title"] == "Touch Display 2 & more"
    assert preview["description"] == 'A 5" screen.'
    assert preview["site"] == "raspberrypi.com"
    assert preview["image"] == "/proxy/image?url=https%3A%2F%2Fwww.raspberrypi.com%2Fimg%2Fhero.jpg"
    assert preview["favicon"].endswith("fav.png")


def test_a_picture_link_to_a_private_address_is_not_proxied():
    assert links.proxied("http://192.168.1.10/cam.jpg") is None


def test_speech_leaves_out_code_and_addresses():
    text = speakable("## Plan\n\n- **Buy** milk, see [the list](https://x.example/l)\n\n```py\nprint(1)\n```\nhttps://a.example")
    assert "print" not in text and "https" not in text and "#" not in text and "*" not in text
    assert "Buy milk, see the list" in text
