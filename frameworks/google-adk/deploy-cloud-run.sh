#!/usr/bin/env bash
# Deploy this Ring member to Google Cloud Run, pinned always-on.
#
#   ./deploy-cloud-run.sh <project> [region]
#
# Before: join once (see README), which leaves the credential bundle at
# .agentmesh/agentmesh-credentials.json. That file goes into Secret Manager and
# is never put in the image.
#
# The shape: one instance, always on (min 1, max 1, CPU always allocated),
# because the agent keeps one outbound connection to the mesh open and a
# stopped instance cannot hear its mail. No public ingress: the agent only
# dials out, to wss://mesh.agentmesh.ai:443. It runs as a service account of
# its own that can read one secret, its own.
#
# Settings you may change: SERVICE, CPU, MEMORY, CREDENTIALS, and HANDLE (the
# handle in ring-member.json, which must be yours: a member's handle names its
# owner).
set -euo pipefail

PROJECT="${1:?usage: ./deploy-cloud-run.sh <project> [region]}"
REGION="${2:-us-central1}"
SERVICE="${SERVICE:-ref-adk}"
CPU="${CPU:-1}"
MEMORY="${MEMORY:-1Gi}"
CREDENTIALS="${CREDENTIALS:-.agentmesh/agentmesh-credentials.json}"
HANDLE="${HANDLE:-$(sed -n 's/.*"handle": *"\([^"]*\)".*/\1/p' ring-member.json)}"
SA_NAME="${SERVICE}-agent"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SECRET_NAME="${SERVICE}-mesh-credentials"
MOUNT="/secrets/agentmesh/credentials.json"
G=(--project "$PROJECT" --quiet)

[ -f "$CREDENTIALS" ] || { echo "No credential bundle at $CREDENTIALS. Join first (see README)."; exit 1; }

gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com "${G[@]}"

# The agent's own identity on Google Cloud, and nothing else on it.
gcloud iam service-accounts describe "$SA" "${G[@]}" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SA_NAME" --display-name "Ring member $HANDLE" "${G[@]}"

# The credential bundle, as a new version of this agent's own secret.
gcloud secrets describe "$SECRET_NAME" "${G[@]}" >/dev/null 2>&1 \
  || gcloud secrets create "$SECRET_NAME" --replication-policy automatic "${G[@]}"
gcloud secrets versions add "$SECRET_NAME" --data-file "$CREDENTIALS" "${G[@]}" >/dev/null
gcloud secrets add-iam-policy-binding "$SECRET_NAME" --member "serviceAccount:$SA" \
  --role roles/secretmanager.secretAccessor "${G[@]}" >/dev/null

# Build from this folder's Dockerfile and run it, pinned.
gcloud run deploy "$SERVICE" --source . --region "$REGION" "${G[@]}" \
  --service-account "$SA" \
  --min-instances 1 --max-instances 1 --no-cpu-throttling \
  --cpu "$CPU" --memory "$MEMORY" --concurrency 10 \
  --ingress internal --no-allow-unauthenticated \
  --set-secrets "$MOUNT=$SECRET_NAME:latest" \
  --set-env-vars "RING_HANDLE=$HANDLE,AGENTMESH_CREDENTIALS_FILE=$MOUNT,AGENTMESH_SERVERS=wss://mesh.agentmesh.ai"

echo "Deployed $SERVICE. Its log should say \"ring member ready: $HANDLE\":"
echo "  gcloud run services logs read $SERVICE --region $REGION --project $PROJECT --limit 20"
