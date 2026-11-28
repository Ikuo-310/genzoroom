from tests.test_raw_controls import identity


def headers(doc):
    return {"X-Raw-Workspace": doc["workspaceId"], "X-Raw-Generation": str(doc["generation"]),
            "X-Raw-Token": doc["documentToken"]}


async def change(http, doc, exposure):
    response = await http.post(f'/api/raw/documents/{doc["handle"]}/controls',
        json=identity(doc) | {"expectedRevision": doc["revision"], "values": {"light.exposure": exposure}})
    assert response.status_code == 200, response.text
    return response.json()
