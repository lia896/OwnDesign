import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.db import settings
from app.responses import fail, ok
from app.routes import consultant, copilot, design, projects, studios

log = logging.getLogger(__name__)
MAX_BODY_BYTES = 2_000_000  # a full 1000-item plan is well under this
MAX_UPLOAD_BODY_BYTES = 6_000_000  # a 5 MB image plus multipart overhead; only POST .../assets

app = FastAPI(title="OwnDesign API", version="1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings().allowed_origins.split(",") if origin.strip()],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)
app.include_router(studios.router)
app.include_router(projects.router)
app.include_router(design.catalog_router)
app.include_router(design.router)
app.include_router(consultant.router)
app.include_router(copilot.router)


class BodyLimit:
    """Stops reading a request body once it passes MAX_BODY_BYTES.

    Counts the bytes that actually arrive, so a chunked upload without Content-Length is capped too.
    Bodies are read before authentication runs, which makes this the only guard against an
    anonymous caller streaming an enormous payload.
    """

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.inner(scope, receive, send)
        received = 0
        is_upload = scope["method"] == "POST" and scope["path"].endswith("/assets")
        limit = MAX_UPLOAD_BODY_BYTES if is_upload else MAX_BODY_BYTES

        async def capped_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise HTTPException(413, "Request too large")
            return message

        await self.inner(scope, capped_receive, send)


app.add_middleware(BodyLimit)


@app.exception_handler(HTTPException)
async def http_error(_: Request, error: HTTPException):
    return JSONResponse(fail(str(error.detail)), status_code=error.status_code)


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, error: RequestValidationError):
    first = error.errors()[0]
    where = ".".join(str(part) for part in first["loc"] if part != "body")
    return JSONResponse(fail(f"Invalid input ({where}): {first['msg']}"), status_code=422)


@app.exception_handler(Exception)
async def unexpected_error(request: Request, error: Exception):
    log.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(fail("Something went wrong. Please try again."), status_code=500)


@app.get("/health")
def health():
    return ok({"status": "ok"})
