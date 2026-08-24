import base64
import json
import os
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key


DEFAULT_LIMIT = 10
MAX_LIMIT = 50
MAX_OFFSET = 10_000

ddb = boto3.resource("dynamodb")
users_table = ddb.Table(os.environ["USERS_TABLE_NAME"])
user_games_table = ddb.Table(os.environ["USER_GAMES_TABLE_NAME"])

CORS_HEADERS = {
    "Access-Control-Allow-Origin": os.environ.get("CORS_ALLOW_ORIGIN", "*"),
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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


def parse_int_param(value: str | None, default: int, min_value: int, max_value: int, name: str) -> int:
    if value is None or value == "":
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"Invalid {name}: must be an integer") from exc
    if parsed < min_value or parsed > max_value:
        raise ValueError(f"Invalid {name}: must be between {min_value} and {max_value}")
    return parsed


def normalize_username(value: str) -> str:
    return value.strip().lower()


def decode_page_token(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        raw = base64.urlsafe_b64decode(token.encode("utf-8")).decode("utf-8")
        data = json.loads(raw)
    except Exception as exc:
        raise ValueError("Invalid next_token") from exc
    if not isinstance(data, dict):
        raise ValueError("Invalid next_token")
    return data


def encode_page_token(last_evaluated_key: dict | None) -> str | None:
    if not last_evaluated_key:
        return None
    raw = json.dumps(to_jsonable(last_evaluated_key), separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("utf-8")


def to_jsonable(value):
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)
    if isinstance(value, list):
        return [to_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: to_jsonable(v) for k, v in value.items()}
    return value


def skip_items(username: str, start_key: dict | None, skip_count: int) -> dict | None:
    exclusive_start_key = start_key
    remaining = skip_count
    while remaining > 0:
        step = min(remaining, MAX_LIMIT)
        kwargs = {
            "KeyConditionExpression": Key("username").eq(username),
            "ScanIndexForward": False,
            "Limit": step,
            "ProjectionExpression": "username, game_timestamp",
        }
        if exclusive_start_key:
            kwargs["ExclusiveStartKey"] = exclusive_start_key
        result = user_games_table.query(**kwargs)
        fetched = len(result.get("Items", []))
        remaining -= fetched
        exclusive_start_key = result.get("LastEvaluatedKey")
        if fetched == 0 or not exclusive_start_key:
            return exclusive_start_key
    return exclusive_start_key


def fetch_recent_games(username: str, limit: int, offset: int, next_key: dict | None) -> tuple[list[dict], str | None]:
    start_key = next_key
    if start_key is None and offset > 0:
        start_key = skip_items(username, None, offset)
        if not start_key:
            return [], None

    kwargs = {
        "KeyConditionExpression": Key("username").eq(username),
        "ScanIndexForward": False,
        "Limit": limit,
    }
    if start_key:
        kwargs["ExclusiveStartKey"] = start_key

    result = user_games_table.query(**kwargs)
    items = [to_jsonable(item) for item in result.get("Items", [])]
    token = encode_page_token(result.get("LastEvaluatedKey"))
    return items, token


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

        query = (event or {}).get("queryStringParameters") or {}
        if not isinstance(query, dict):
            query = {}
        next_token = (query.get("next_token") or "").strip()
        limit = parse_int_param(query.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT, "limit")
        offset = parse_int_param(query.get("offset"), 0, 0, MAX_OFFSET, "offset")
        if next_token and offset:
            return response(400, {"error": "Provide either next_token or offset, not both"})

        start_key = decode_page_token(next_token) if next_token else None
        games, new_token = fetch_recent_games(chess_username, limit, offset, start_key)
        return response(
            200,
            {
                "ok": True,
                "email": email,
                "username": chess_username,
                "limit": limit,
                "offset": offset if not next_token else None,
                "count": len(games),
                "games": games,
                "next_token": new_token,
            },
        )
    except ValueError as exc:
        return response(400, {"error": str(exc)})
    except Exception as exc:
        return response(500, {"error": str(exc)})
