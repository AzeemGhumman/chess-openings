import os
from typing import Optional

from google.auth.transport import requests
from google.oauth2 import id_token


def parse_bearer_token(auth_header: Optional[str]) -> str:
    if not auth_header:
        raise ValueError("Missing Authorization header")
    parts = auth_header.strip().split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise ValueError("Authorization must be a Bearer token")
    token = parts[1].strip()
    if not token:
        raise ValueError("Empty bearer token")
    return token


def allowed_client_ids() -> list[str]:
    raw = os.environ.get("GOOGLE_CLIENT_IDS", "")
    return [x.strip() for x in raw.split(",") if x.strip()]


def generate_policy(principal_id: str, effect: str, resource: str, context: Optional[dict] = None) -> dict:
    policy = {
        "principalId": principal_id,
        "policyDocument": {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Action": "execute-api:Invoke",
                    "Effect": effect,
                    "Resource": resource,
                }
            ],
        },
    }
    if context:
        policy["context"] = {k: str(v) for k, v in context.items() if v is not None}
    return policy


def wildcard_resource_for_api(method_arn: str) -> str:
    # method_arn: arn:aws:execute-api:{region}:{account}:{apiId}/{stage}/{method}/{resourcePath}
    parts = method_arn.split("/")
    if len(parts) < 2:
        return method_arn
    return f"{parts[0]}/{parts[1]}/*/*"


def lambda_handler(event, context):
    method_arn = event.get("methodArn", "*")
    wildcard_resource = wildcard_resource_for_api(method_arn)
    token_header = event.get("authorizationToken", "")

    try:
        bearer = parse_bearer_token(token_header)
        audiences = allowed_client_ids()
        if not audiences:
            return generate_policy("unauthorized", "Deny", wildcard_resource, {"reason": "Missing GOOGLE_CLIENT_IDS"})

        req = requests.Request()
        verified = None
        last_error = None
        for aud in audiences:
            try:
                verified = id_token.verify_oauth2_token(bearer, req, aud)
                break
            except Exception as exc:
                last_error = exc

        if not verified:
            raise ValueError(f"Google token verification failed: {last_error}")

        email = verified.get("email")
        sub = verified.get("sub")
        if not email or not sub:
            raise ValueError("Token missing required claims")

        return generate_policy(
            principal_id=sub,
            effect="Allow",
            resource=wildcard_resource,
            context={
                "email": email.lower(),
                "sub": sub,
                "name": verified.get("name", ""),
            },
        )
    except Exception:
        return generate_policy("unauthorized", "Deny", wildcard_resource)
