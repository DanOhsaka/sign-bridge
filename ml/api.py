
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field



from .inference import SignBridgeLSTM

from fastapi.middleware.cors import CORSMiddleware

classifier = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global classifier

    classifier = SignBridgeLSTM()

    yield

    classifier = None


app = FastAPI(
    title="SignBridge LSTM API",
    version="1.0.0",
    lifespan=lifespan
)


# Browser access is restricted to local development origins.
# The production Node.js backend can call this API server-to-server.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://[::1]:8000",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class PredictionRequest(BaseModel):
    frames: list[dict] = Field(
        min_length=30,
        max_length=30
    )


@app.get("/health")
def health():

    return {
        "status": "ready",
        "model": "signbridge_lstm",
        "labels": classifier.labels
    }


@app.post("/predict")
def predict(request: PredictionRequest):

    try:
        return classifier.predict(request.frames)

    except (ValueError, TypeError, KeyError) as error:
        raise HTTPException(
            status_code=422,
            detail=str(error)
        )
