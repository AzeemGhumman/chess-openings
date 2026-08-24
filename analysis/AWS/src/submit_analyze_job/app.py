import json
import os
import uuid
from datetime import datetime, UTC
import math

import boto3


ddb = boto3.resource("dynamodb")
sqs = boto3.client("sqs")

users_table = ddb.Table(os.environ["USERS_TABLE_NAME"])
job_queue_url = os.environ["ANALYZE_JOB_QUEUE_URL"]
ANALYZE_COOLDOWN_SECONDS = 60 * 60

CORS_HEADERS = {
    "Access-Control-Allow-Origin": os.environ.get("CORS_ALLOW_ORIGIN", "*"),
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
}


def response(status_code: int, payload: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            **CORS_HEADERS,
        },
        "body": json.dumps(payload),
    }


def authenticated_email(event: dict) -> str:
    authorizer = (event or {}).get("requestContext", {}).get("authorizer", {})
    return (authorizer.get("email") or "").strip().lower()


def parse_iso8601_utc(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError:
        return None


def normalize_username(value: str) -> str:
    return value.strip().lower()


def lambda_handler(event, context):
    try:
        email = authenticated_email(event if isinstance(event, dict) else {})
        if not email:
            return response(401, {"error": "Unauthorized: missing authenticated email"})

        user = users_table.get_item(Key={"email": email}).get("Item")
        if not user:
            return response(404, {"error": f"No user mapping found for email: {email}"})

        chess_username = normalize_username(user.get("chess_com_username") or "")
        if not chess_username:
            return response(400, {"error": f"User {email} does not have chess_com_username set"})

        now_dt = datetime.now(UTC)
        last_request_dt = parse_iso8601_utc((user.get("last_analyze_requested_at") or "").strip())
        if last_request_dt:
            elapsed_seconds = (now_dt - last_request_dt).total_seconds()
            if elapsed_seconds < ANALYZE_COOLDOWN_SECONDS:
                remaining_seconds = ANALYZE_COOLDOWN_SECONDS - elapsed_seconds
                remaining_minutes = math.ceil(remaining_seconds / 60)
                return response(
                    429,
                    {
                        "error": "Analyze request cooldown active",
                        "message": f"Please wait another {remaining_minutes} minute(s) before requesting analysis again.",
                        "retry_after_minutes": remaining_minutes,
                    },
                )

        job_id = str(uuid.uuid4())
        now = now_dt.isoformat().replace("+00:00", "Z")
        payload = {
            "job_id": job_id,
            "email": email,
            "chess_com_username": chess_username,
            "submitted_at": now,
        }

        send_kwargs = {
            "QueueUrl": job_queue_url,
            "MessageBody": json.dumps(payload),
        }
        if job_queue_url.endswith(".fifo"):
            send_kwargs["MessageGroupId"] = "default"
        sqs.send_message(**send_kwargs)

        user["last_analyze_requested_at"] = now
        users_table.put_item(Item=user)

        return response(
            202,
            {
                "ok": True,
                "job_id": job_id,
                "email": email,
                "chess_com_username": chess_username,
                "status": "queued",
            },
        )
    except Exception as exc:
        return response(500, {"error": str(exc)})
