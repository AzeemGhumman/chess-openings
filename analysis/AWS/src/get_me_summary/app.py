import json
import os
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key


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


def normalize_username(value: str) -> str:
    return value.strip().lower()


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


def count_user_games(username: str) -> int:
    total = 0
    start_key = None
    while True:
        kwargs = {
            "KeyConditionExpression": Key("username").eq(username),
            "Select": "COUNT",
        }
        if start_key:
            kwargs["ExclusiveStartKey"] = start_key
        result = user_games_table.query(**kwargs)
        total += int(result.get("Count", 0))
        start_key = result.get("LastEvaluatedKey")
        if not start_key:
            break
    return total


def latest_game(username: str) -> dict | None:
    result = user_games_table.query(
        KeyConditionExpression=Key("username").eq(username),
        ScanIndexForward=False,
        Limit=1,
    )
    items = result.get("Items", [])
    if not items:
        return None
    return to_jsonable(items[0])


def lambda_handler(event, context):
    try:
        email = authenticated_email(event if isinstance(event, dict) else {})
        if not email:
            return response(401, {"error": "Unauthorized: missing authenticated email"})

        user = users_table.get_item(Key={"email": email}).get("Item")
        if not user:
            return response(404, {"error": f"No user mapping found for email: {email}"})

        chess_username = normalize_username(user.get("chess_com_username") or "")
        profile = {
            "email": email,
            "name": user.get("name", ""),
            "chess_com_username": chess_username,
            "lichess_username": user.get("lichess_username", ""),
            "updated_at": user.get("updated_at"),
            "last_analyze_requested_at": user.get("last_analyze_requested_at"),
        }

        summary = {
            "profile": profile,
            "analyzed_games_count": 0,
            "latest_game": None,
        }
        if chess_username:
            summary["analyzed_games_count"] = count_user_games(chess_username)
            summary["latest_game"] = latest_game(chess_username)

        return response(
            200,
            {
                "ok": True,
                "summary": summary,
            },
        )
    except Exception as exc:
        return response(500, {"error": str(exc)})
