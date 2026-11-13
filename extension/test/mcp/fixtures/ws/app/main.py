import os

DEBUG_FLAG = "1"
retries: int = 3


def get_debug_flag() -> bool:
    """Return flag."""
    local = 5
    return os.environ.get("DEBUG") == "1"


class Service(Base):
    limit = 10

    def run(self, cmd: str,
            timeout: int = 5) -> str:
        return get_debug_flag()

    async def stop(self):
        pass
