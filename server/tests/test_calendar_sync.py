import os
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

from server.calendar_sync import calendar_align, calendar_book, calendar_change, calendar_list


class CalendarSyncTest(unittest.TestCase):
    def test_edit_updates_only_the_selected_occurrence_and_is_safe_to_retry(self):
        start, end = '2026-11-19T17:00:00+01:00', '2026-11-19T18:00:00+01:00'
        stored = {'id':'instance','summary':'Персональная · Тестовая Вера · Сергей','etag':'"v1"',
                  'recurringEventId':'series','start':{'dateTime':start},'end':{'dateTime':end},'location':'Парк'}
        writes = []

        def request(**kwargs):
            if kwargs.get('method') == 'PATCH':
                writes.append(kwargs)
                stored.update(kwargs['body'])
            return stored

        payload = {'eventId':'instance','action':'edit','expected':{'start':start,'end':end,'location':'Парк'},
                   'day':'2026-11-21','time':'16:00','minutes':75,'location':'Зал'}
        with patch.dict(os.environ, {'TRAIL_GOOGLE_SERVICE_ACCOUNT':'test','TRAIL_GOOGLE_CALENDAR_ID':'test'}):
            first = calendar_change(payload,request=request)
            second = calendar_change(payload,request=request)
            self.assertIn('error',calendar_change({**payload,'location':'Калемегдан'},request=request))
        self.assertEqual(first,second)
        self.assertEqual(first['event']['start'],'2026-11-21T16:00:00+01:00')
        self.assertEqual(first['event']['end'],'2026-11-21T17:15:00+01:00')
        self.assertEqual(len(writes),1)
        self.assertEqual((writes[0]['path'],writes[0]['etag']),('/instance','"v1"'))
        self.assertEqual(writes[0]['params']['sendUpdates'],'none')
        self.assertEqual(set(writes[0]['body']),{'start','end','location'})

    def test_cancel_checks_the_actual_times_and_rejects_recurring_series(self):
        start, end = '2026-11-19T17:00:00+01:00', '2026-11-19T18:00:00+01:00'
        stored = {'id':'training','summary':'Персональная · Тестовая Вера · Сергей','etag':'"v1"',
                  'start':{'dateTime':start},'end':{'dateTime':end},'location':'Парк'}
        deletes = []

        def request(**kwargs):
            if kwargs.get('method') == 'DELETE':
                deletes.append(kwargs)
                stored['status'] = 'cancelled'
                return {}
            return stored

        payload = {'eventId':'training','action':'cancel','expected':{'start':start,'end':end,'location':'Парк'}}
        with patch.dict(os.environ, {'TRAIL_GOOGLE_SERVICE_ACCOUNT':'test','TRAIL_GOOGLE_CALENDAR_ID':'test'}):
            self.assertIn('error',calendar_change({**payload,'expected':{**payload['expected'],'location':'Старый зал'}},request=request))
            stored['recurrence'] = ['RRULE:FREQ=WEEKLY']
            self.assertIn('error',calendar_change(payload,request=request))
            del stored['recurrence']
            self.assertEqual(calendar_change(payload,request=request),{'status':'cancelled'})
            self.assertEqual(calendar_change(payload,request=request),{'status':'cancelled'})
        self.assertEqual(deletes,[{'path':'/training','params':{'sendUpdates':'none'},'method':'DELETE','etag':'"v1"'}])

    def test_align_patches_only_title_and_client_for_an_unchanged_event(self):
        event = {'id':'existing','summary':'Персональная · Владимир · Сергей','etag':'"v1"',
                 'start':{'dateTime':'2026-11-17T17:30:00+01:00'},'end':{'dateTime':'2026-11-17T18:30:00+01:00'},
                 'extendedProperties':{'private':{'trailTaskId':'some-task'}}}
        writes = []

        def request(**kwargs):
            if kwargs.get('method') == 'PATCH':
                writes.append(kwargs)
            return event

        payload = {'eventId':'existing','expectedTitle':event['summary'],'clientId':'client-1','clientName':'Тестов Владимир'}
        with patch.dict(os.environ, {'TRAIL_GOOGLE_SERVICE_ACCOUNT':'test','TRAIL_GOOGLE_CALENDAR_ID':'test'}):
            self.assertEqual(calendar_align(payload,request=request),{'status':'changed'})
            event['attendees'] = [{}]
            self.assertEqual(calendar_align(payload,request=request),{'status':'skipped'})
        self.assertEqual(writes,[{'path':'/existing','params':{'sendUpdates':'none'},'method':'PATCH','etag':'"v1"',
            'body':{'summary':'Персональная · Тестов Владимир · Сергей',
                    'extendedProperties':{'private':{'trailTaskId':'some-task','trailClientId':'client-1'}}}}])

    def test_list_only_includes_coachs_personal_sessions_and_paginates(self):
        event = {'id': 'existing', 'summary': 'Персональная · Эмилия · Сергей',
                 'start': {'dateTime': '2026-11-19T15:30:00+01:00'},
                 'end': {'dateTime': '2026-11-19T16:30:00+01:00'}}
        pages = []

        def request(params):
            pages.append(params.get('pageToken'))
            if len(pages) == 1:
                return {'items': [{**event, 'summary': 'Групповая тренировка'},
                                  {**event, 'summary': 'Персональная · Эмилия · Другой тренер'},
                                  {**event, 'status': 'cancelled'}], 'nextPageToken': 'page2'}
            return {'items': [event]}

        with patch.dict(os.environ, {'TRAIL_GOOGLE_SERVICE_ACCOUNT': 'test', 'TRAIL_GOOGLE_CALENDAR_ID': 'test'}):
            result = calendar_list({'from': '2026-11-17', 'to': '2026-11-21'}, request=request)
        self.assertEqual(pages, [None, 'page2'])
        self.assertEqual(result['mode'], 'live')
        self.assertEqual([item['id'] for item in result['events']], ['existing'])

    def test_retry_returns_same_event_in_belgrade_time_without_invitations(self):
        stored = {}

        def request(path='', params=None, body=None):
            if path:
                return stored[path[1:]]
            self.assertEqual(params, {'sendUpdates': 'none'})
            self.assertNotIn('attendees', body)
            if body['id'] in stored:
                raise HTTPError('https://calendar.google.com', 409, 'Exists', {}, None)
            stored[body['id']] = body
            return body

        booking = {'taskId': 'task-1', 'clientId': 'client-1', 'clientName': 'Тестовый клиент',
                   'day': '2026-07-22', 'time': '15:30', 'minutes': 60, 'location': 'Зал'}
        with patch.dict(os.environ, {'TRAIL_GOOGLE_SERVICE_ACCOUNT': 'test', 'TRAIL_GOOGLE_CALENDAR_ID': 'test'}):
            first = calendar_book(booking, request=request)
            second = calendar_book(booking, request=request)
            changed = calendar_book({**booking, 'time': '16:30'}, request=request)
        self.assertEqual(first, second)
        self.assertEqual(first['event']['start'], '2026-07-22T15:30:00+02:00')
        self.assertEqual(len(stored), 1)
        self.assertIn('error', changed)
