import json
import os
from datetime import datetime, UTC

import boto3


ddb = boto3.resource("dynamodb")
users_table = ddb.Table(os.environ["USERS_TABLE_NAME"])

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


def parse_event_body(event: dict) -> dict:
    body = event
    if isinstance(event, dict) and isinstance(event.get("body"), str):
        body = json.loads(event["body"] or "{}")
    return body if isinstance(body, dict) else {}


def authenticated_email(event: dict) -> str:
    authorizer = (event or {}).get("requestContext", {}).get("authorizer", {})
    email = (authorizer.get("email") or "").strip().lower()
    return email


def normalize_username(value: str) -> str:
    return value.strip().lower()


def lambda_handler(event, context):
    try:
        body = parse_event_body(event if isinstance(event, dict) else {})
        email = authenticated_email(event if isinstance(event, dict) else {})
        if not email:
            return response(401, {"error": "Unauthorized: missing authenticated email"})

        name = (body.get("name") or "").strip()
        chess_com_username = normalize_username(body.get("chess_com_username") or "")
        lichess_username = (body.get("lichess_username") or "").strip()

        now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        item = {
            "email": email,
            "updated_at": now,
        }
        if name:
            item["name"] = name
        if chess_com_username:
            item["chess_com_username"] = chess_com_username
        if lichess_username:
            item["lichess_username"] = lichess_username

        users_table.put_item(Item=item)
        return response(200, {"ok": True, "user": item})
    except Exception as exc:
        return response(500, {"error": str(exc)})
