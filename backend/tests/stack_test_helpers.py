import httpx


def with_empty_stacks(handler):
    def dispatch(request):
        if request.url.path == "/api/stacks":
            assert request.method == "GET"
            return httpx.Response(200, json=[])
        return handler(request)
    return dispatch
