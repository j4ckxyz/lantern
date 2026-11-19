"""The two errors everything in the service speaks in. Their text is shown to the person as it is."""


class LanternError(RuntimeError):
    """Something a person should be told, in a sentence they can read."""


class NeedsSignIn(LanternError):
    """Hermes wants a username and password before going further."""
