# One Ring member in one container. It dials out to the mesh and needs no
# inbound traffic; the small HTTP answer on $PORT is only for Cloud Run's
# health check. No key or credential is in the image: the credential bundle
# is mounted from Secret Manager at run time (AGENTMESH_CREDENTIALS_FILE).
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    CREWAI_DISABLE_TELEMETRY=true OTEL_SDK_DISABLED=true
# git: pip installs the AgentMesh SDK from its repository.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY ring.py agent.py ./
RUN useradd --create-home member
USER member
CMD ["python", "agent.py"]
