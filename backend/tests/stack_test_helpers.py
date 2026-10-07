import httpx


def with_empty_stacks(handler):
    def dispatch(request):
        if request.url.path in ("/api/stacks", "/api/tags"):
            assert request.method == "GET"
            return httpx.Response(200, json=[])
        return handler(request)
    return dispatch
