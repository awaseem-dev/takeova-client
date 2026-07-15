# MINE Web Hands Runner

A microservice that runs Claude Computer Use tasks inside a sandboxed Linux desktop
with Chrome. Pairs with the MINE backend (`/api/browser-agent/*` routes).

## What it does

When a MINE customer runs a Web Hands task:
1. MINE backend POSTs to this runner's `/run` endpoint
2. Runner starts a fresh Chrome session inside `Xvfb` (virtual display)
3. Runner runs Claude's Computer Use loop (screenshot → Claude decides → click/type → repeat)
4. When done, returns the final result + audit transcript

## Local quickstart

```bash
# 1) Build the image
docker compose build

# 2) Set a shared secret — MUST match INTERNAL_API_KEY on the MINE backend
export INTERNAL_API_KEY="$(openssl rand -hex 32)"
echo "INTERNAL_API_KEY=$INTERNAL_API_KEY"  # save this — you'll set it on MINE too

# 3) Start
docker compose up -d

# 4) Health check
curl http://localhost:8000/health
# {"ok": true, "ts": ...}

# 5) Test a task (smoke test — opens Google and searches)
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -H "X-Internal-Auth: $INTERNAL_API_KEY" \
  -d '{
    "task_id": "test-1",
    "user_id": "test-user",
    "anthropic_key": "sk-ant-YOUR-REAL-KEY",
    "model": "claude-opus-4-7",
    "max_actions": 10,
    "system_prompt": "You are a careful browser assistant.",
    "forbidden_patterns": ["password reset", "wire transfer"],
    "prompt": "Go to google.com and search for the current weather in Sydney",
    "start_url": "https://google.com",
    "tools": [{"type":"computer_20241022","name":"computer","display_width_px":1280,"display_height_px":800,"display_number":1}]
  }'
```

## Watching the browser live (debug only)

```bash
ENABLE_VNC=true docker compose up -d
# Then point a VNC client (e.g. macOS Screen Sharing) at localhost:5900
```

## Production deploy to AWS ECS Fargate

### Step 1 — Push the image to ECR

```bash
AWS_REGION="ap-southeast-2"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

aws ecr create-repository --repository-name mine-webhands-runner --region $AWS_REGION
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR

docker build -t mine-webhands-runner .
docker tag mine-webhands-runner:latest $ECR/mine-webhands-runner:latest
docker push $ECR/mine-webhands-runner:latest
```

### Step 2 — Create the ECS task

Minimum task definition (Fargate, 2 vCPU + 4GB RAM is comfortable for one concurrent task):

```json
{
  "family": "mine-webhands-runner",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "2048",
  "memory": "4096",
  "executionRoleArn": "arn:aws:iam::YOUR_ACCOUNT:role/ecsTaskExecutionRole",
  "containerDefinitions": [{
    "name": "runner",
    "image": "YOUR_ECR/mine-webhands-runner:latest",
    "portMappings": [{"containerPort": 8000, "protocol": "tcp"}],
    "environment": [
      {"name": "INTERNAL_API_KEY", "value": "YOUR_SHARED_SECRET"}
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/mine-webhands-runner",
        "awslogs-region": "ap-southeast-2",
        "awslogs-stream-prefix": "ecs"
      }
    }
  }]
}
```

### Step 3 — Put a load balancer in front

Application Load Balancer → target group on port 8000.
Use the ALB's HTTPS URL for `BROWSER_AGENT_RUNNER_URL` on MINE backend.

### Step 4 — Set MINE env vars to point at it

On your MINE backend (Railway, Fly, wherever):
```
BROWSER_AGENT_RUNNER_URL=https://your-runner.your-domain.com
ANTHROPIC_API_KEY=sk-ant-...
INTERNAL_API_KEY=<same secret you put in the runner>
CREDENTIAL_VAULT_KEY=<32-byte hex, e.g. openssl rand -hex 32>
```

## Operational concerns

### One task per container at a time
This runner is designed for one concurrent task per container. The Xvfb + Chrome
state is per-task. For higher throughput, run multiple ECS tasks behind the ALB
(Fargate will auto-spawn based on target tracking).

### Cost estimate
- 1 task running 24/7 on Fargate 2vCPU/4GB ≈ $50-60/month in ap-southeast-2
- Or scale-to-zero with ECS Service min=0 + ALB sticky routing — cheaper but cold-start adds 15-30s to first task

### Anthropic API costs
Computer Use is image-heavy. A 50-action task can run $0.50-2 in Anthropic token costs. Budget for this when setting customer overage rates.

### Known limitations (v1)
- No file download support — Claude can navigate but downloaded files stay in the container and aren't extracted
- No persistent cookies — every task starts fresh (intentional for security but breaks some workflows)
- Single display (1280x800) — no multi-monitor or window management beyond fluxbox
- No 2FA TOTP support yet — credential vault has the secret slot but runner doesn't use it
- Chrome version pinned to whatever's current at image build time

### Security considerations
- The `/run` endpoint requires `X-Internal-Auth` matching `INTERNAL_API_KEY`
- This must match the MINE backend's `INTERNAL_API_KEY` env var
- Don't expose port 8000 publicly without auth or restricting source IPs to your MINE backend
- The credential unlock callback goes from runner → MINE; make sure MINE is reachable from the runner's VPC

### Updating
```bash
docker compose build
docker tag mine-webhands-runner:latest $ECR/mine-webhands-runner:latest
docker push $ECR/mine-webhands-runner:latest
aws ecs update-service --cluster <cluster> --service mine-webhands-runner --force-new-deployment
```

## Honest scope

This is a working v1 starter. Production hardening you'll likely want over time:
- Per-task isolation via ephemeral containers (fork+exec instead of single Flask worker)
- Distributed tracing
- Better forbidden-pattern detection (semantic, not just substring)
- Download/upload file handling
- Retry logic on transient Claude API errors
- Rate limiting per user_id
