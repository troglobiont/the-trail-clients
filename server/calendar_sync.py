"""Connect the private coach API to the single configured Google calendar."""

import base64
from datetime import date, datetime, time, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


BELGRADE = ZoneInfo('Europe/Belgrade')
SCOPES = ['https://www.googleapis.com/auth/calendar.events']
EVENT_FIELDS = 'id,summary,start,end,location,status,extendedProperties'


def event_view(raw):
    title = raw.get('summary', '').strip()
    if raw.get('status') == 'cancelled' or not re.fullmatch(r'персональная\s*·[^·]+·\s*сергей', title, re.I):
        return None
    start, end = raw.get('start', {}).get('dateTime'), raw.get('end', {}).get('dateTime')
    if not (start and end and raw.get('id')):
        return None
    return {'id': raw['id'], 'title': title, 'start': start, 'end': end,
            'location': raw.get('location', ''), 'clientId': raw.get('extendedProperties', {}).get('private', {}).get('trailClientId')}


def date_range(payload):
    start, end = (date.fromisoformat(payload[key]) for key in ('from', 'to'))
    if not 0 < (end - start).days <= 31:
        raise ValueError('Выбери период не длиннее месяца')
    return (datetime.combine(start, time.min, BELGRADE), datetime.combine(end, time.min, BELGRADE))


def google_request(path='', params=None, body=None):
    from google.auth.transport.requests import Request as GoogleAuthRequest
    from google.oauth2.service_account import Credentials

    account = os.environ['TRAIL_GOOGLE_SERVICE_ACCOUNT']
    calendar = quote(os.environ['TRAIL_GOOGLE_CALENDAR_ID'], safe='')
    credentials = Credentials.from_service_account_file(account, scopes=SCOPES)
    auth_request = GoogleAuthRequest()
    credentials.refresh(lambda *args, **kwargs: auth_request(*args, **{**kwargs, 'timeout': 10}))
    url = f'https://www.googleapis.com/calendar/v3/calendars/{calendar}/events{path}'
    if params:
        url += '?' + urlencode(params)
    headers = {'Authorization': f'Bearer {credentials.token}', 'Content-Type': 'application/json'}
    request = Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers)
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def calendar_connected():
    return bool(os.environ.get('TRAIL_GOOGLE_SERVICE_ACCOUNT') and os.environ.get('TRAIL_GOOGLE_CALENDAR_ID'))


def event_link(event_id):
    calendar = os.environ.get('TRAIL_GOOGLE_CALENDAR_ID', '')
    if not calendar:
        return ''
    key = base64.urlsafe_b64encode(f'{event_id} {calendar}'.encode()).decode().rstrip('=')
    return f'https://calendar.google.com/calendar/event?eid={key}'


def calendar_list(payload, request=google_request):
    start, end = date_range(payload)
    if not calendar_connected():
        source = os.environ.get('TRAIL_CALENDAR_SNAPSHOT')
        if not source:
            return {'mode': 'not-connected', 'events': []}
        snapshot = json.loads(Path(source).read_text())
        events = [{**event, 'url': event_link(event['id'])} for event in snapshot['events']
                  if start <= datetime.fromisoformat(event['start']) < end]
        events.sort(key=lambda event: datetime.fromisoformat(event['start']))
        return {'mode': 'snapshot', 'asOf': snapshot['asOf'], 'events': events}
    params = {'timeMin': start.isoformat(), 'timeMax': end.isoformat(), 'singleEvents': 'true',
              'orderBy': 'startTime', 'maxResults': '250', 'fields': f'nextPageToken,items({EVENT_FIELDS})'}
    events = []
    while True:
        response = request(params=params)
        events.extend(event for raw in response.get('items', []) if (event := event_view(raw)))
        next_page = response.get('nextPageToken')
        if not next_page:
            break
        params['pageToken'] = next_page
    for event in events:
        event['url'] = event_link(event['id'])
    return {'mode': 'live', 'events': events}


def calendar_book(payload, request=google_request):
    client_id, task_id = (payload[key] for key in ('clientId', 'taskId'))
    if any(not re.fullmatch(r'[a-zA-Z0-9_-]{1,180}', value) for value in (client_id, task_id)):
        raise ValueError('Некорректная задача или клиент')
    if not calendar_connected():
        return {'error': 'Сначала подключи Google Календарь'}
    name, location = (payload[key].strip() for key in ('clientName', 'location'))
    starts = datetime.combine(date.fromisoformat(payload['day']), time.fromisoformat(payload['time']), BELGRADE)
    duration = payload['minutes']
    if not (0 < len(name) <= 180 and len(location) <= 180 and '·' not in name
            and type(duration) is int and 15 <= duration <= 180):
        raise ValueError('Проверь имя, время и длительность занятия')
    utc_start = starts.astimezone(timezone.utc)
    if utc_start.astimezone(BELGRADE) != starts or starts.replace(fold=1).utcoffset() != starts.utcoffset():
        raise ValueError('Выбери другое время из-за перехода на летнее или зимнее время')
    ends = (utc_start + timedelta(minutes=duration)).astimezone(BELGRADE)
    event_id = hashlib.sha256((client_id + ':' + task_id).encode()).hexdigest()[:32]
    body = {'id': event_id, 'summary': f'Персональная · {name} · Сергей', 'location': location,
            'description': 'Тип: персональная тренировка. Тренер: Сергей.', 'colorId': '10',
            'start': {'dateTime': starts.isoformat(), 'timeZone': 'Europe/Belgrade'},
            'end': {'dateTime': ends.isoformat(), 'timeZone': 'Europe/Belgrade'},
            'extendedProperties': {'private': {'trailTaskId': task_id, 'trailClientId': client_id}}}
    try:
        raw = request(params={'sendUpdates': 'none'}, body=body)
    except HTTPError as error:
        if error.code != 409:
            raise
        raw = request(path='/' + event_id)
    event = event_view(raw)
    if (not event or event['clientId'] != client_id or datetime.fromisoformat(event['start']) != starts
            or datetime.fromisoformat(event['end']) != ends or event['location'] != location):
        return {'error': 'Для задачи уже есть тренировка с другим временем. Проверь календарь.'}
    event['url'] = event_link(event_id)
    return {'event': event}
