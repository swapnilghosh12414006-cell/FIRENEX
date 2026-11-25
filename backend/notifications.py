import asyncio
import logging
import os
import smtplib
from email.message import EmailMessage
from typing import Any


logger = logging.getLogger("emberwatch.notifications")


def email_is_configured() -> bool:
    use_ssl = os.getenv("SMTP_USE_SSL", "false").strip().lower() == "true"
    use_starttls = os.getenv("SMTP_STARTTLS", "true").strip().lower() == "true"
    username = os.getenv("SMTP_USERNAME") or os.getenv("SMTP_USER")
    try:
        port = int(os.getenv("SMTP_PORT", "587"))
    except ValueError:
        return False
    return bool(
        os.getenv("SMTP_HOST")
        and os.getenv("SMTP_FROM")
        and 1 <= port <= 65535
        and use_ssl != use_starttls
        and (not username or os.getenv("SMTP_PASSWORD"))
    )


def _send_message(message: EmailMessage, recipient: str) -> None:
    host = os.getenv("SMTP_HOST")
    if not host or not os.getenv("SMTP_FROM"):
        raise RuntimeError("SMTP_HOST and SMTP_FROM must be configured to send alerts.")
    port = int(os.getenv("SMTP_PORT", "587"))
    if not 1 <= port <= 65535:
        raise ValueError("SMTP_PORT must be between 1 and 65535.")
    use_ssl = os.getenv("SMTP_USE_SSL", "false").strip().lower() == "true"
    use_starttls = os.getenv("SMTP_STARTTLS", "true").strip().lower() == "true"
    if not use_ssl and not use_starttls:
        raise RuntimeError("SMTP must use SSL or STARTTLS; plaintext delivery is disabled.")
    if use_ssl and use_starttls:
        raise RuntimeError("Choose either SMTP_USE_SSL or SMTP_STARTTLS, not both.")
    server_class = smtplib.SMTP_SSL if use_ssl else smtplib.SMTP
    with server_class(host, port, timeout=10) as server:
        if use_starttls:
            server.starttls()
        username = os.getenv("SMTP_USERNAME") or os.getenv("SMTP_USER")
        password = os.getenv("SMTP_PASSWORD")
        if username:
            server.login(username, password or "")
        server.send_message(message, to_addrs=[recipient])


def _send_email(alert: dict[str, Any], recipient: str) -> None:
    sender = os.getenv("SMTP_FROM")
    if not sender:
        raise RuntimeError("SMTP_FROM must be configured to send alerts.")
    message = EmailMessage()
    message["Subject"] = f"Emberwatch critical fire detection — {alert['location']}"
    message["From"] = sender
    message["To"] = recipient
    message.set_content(
        "A fire-class detection was returned by the configured YOLO model.\n\n"
        f"Location: {alert['location']}\n"
        f"Confidence: {alert['confidence']:.1%}\n"
        f"Timestamp: {alert['timestamp']}\n\n"
        "Verify the scene and follow your site's emergency procedures. "
        "This automated alert is not a substitute for certified fire alarms."
    )
    _send_message(message, recipient)


def _send_sos_email(incident: dict[str, Any], recipient: str) -> None:
    sender = os.getenv("SMTP_FROM")
    if not sender:
        raise RuntimeError("SMTP_FROM must be configured to send emergency notifications.")
    message = EmailMessage()
    message["Subject"] = f"Emberwatch SOS request — {incident['location']}"
    message["From"] = sender
    message["To"] = recipient
    message.set_content(
        "An operator explicitly requested an emergency contact notification.\n\n"
        f"Location: {incident['location']}\n"
        f"Timestamp: {incident['timestamp']}\n"
        f"Message: {incident['message']}\n\n"
        "This notification is not a connection to emergency services. "
        "Follow the site's response plan and contact local emergency services directly when needed."
    )
    _send_message(message, recipient)


def _send_test_email(recipient: str) -> None:
    sender = os.getenv("SMTP_FROM")
    if not sender:
        raise RuntimeError("SMTP_FROM must be configured to send a test email.")
    message = EmailMessage()
    message["Subject"] = "Emberwatch SMTP configuration test"
    message["From"] = sender
    message["To"] = recipient
    message.set_content(
        "This test message confirms that Emberwatch can submit email through the configured SMTP relay."
    )
    _send_message(message, recipient)


async def send_critical_email(alert: dict[str, Any], recipient: str) -> None:
    try:
        await asyncio.to_thread(_send_email, alert, recipient)
    except Exception:
        logger.exception("Could not send critical alert email to %s", recipient)


async def send_sos_email(incident: dict[str, Any], recipient: str) -> None:
    try:
        await asyncio.to_thread(_send_sos_email, incident, recipient)
    except Exception:
        logger.exception("Could not send SOS notification email to %s", recipient)


async def send_test_email(recipient: str) -> None:
    await asyncio.to_thread(_send_test_email, recipient)
