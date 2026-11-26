import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient,emptyState,saveProfile,validateState} from '../src/core.js';
import {OWNER_COACH,sportProfilesVisible} from '../src/role-preview.js';
import {removeSportProfile,saveSportProfile,sportProfileUrl} from '../src/sport-profiles.js';
import {cloudData} from '../src/cloud-state.js';

const checked={source:'Спортсмен прислал ссылку',checkedOn:'2026-11-23'};
const garmin={...checked,service:'garmin',type:'profile',url:'https://connect.garmin.com/modern/profile/example-runner'};
const suunto={...checked,service:'suunto',type:'username',username:'@runner_example'};

test('only stable account links are canonicalized',()=>{
  assert.equal(sportProfileUrl('garmin','profile',garmin.url+'?tracking=1'),
    'https://connect.garmin.com/app/profile/example-runner');
  assert.equal(sportProfileUrl('trainingpeaks','coach','https://app.trainingpeaks.com/#calendar/athletes/1234'),
    'https://app.trainingpeaks.com/#calendar/athletes/1234');
  assert.equal(sportProfileUrl('strava','profile','https://strava.com/athletes/1234/'),'https://www.strava.com/athletes/1234');
  for(const url of [
    'http://www.strava.com/athletes/1234','https://www.strava.com/activities/1234','https://www.strava.com/athletes/1234/training/log',
    'https://www.strava.com.bad.example/athletes/1234','https://someone@www.strava.com/athletes/1234',
    'https://connect.garmin.com/app/activity/1','https://connect.garmin.com/app/profile/myid/friends/followers'
  ]){
    const provider=url.includes('garmin')?'garmin':'strava';
    assert.equal(sportProfileUrl(provider,'profile',url),'');
  }
});

test('multiple verified profiles remain on the existing synced client without changing contacts',()=>{
  const state=emptyState();
  const runner=createClient(state,{name:'Проверочный клиент'}),other=createClient(state,{name:'Другой клиент'});
  assert.equal(runner.sportProfiles,undefined);
  const saved=saveSportProfile(state,runner.id,garmin);
  const username=saveSportProfile(state,runner.id,suunto);
  assert.equal(username.username,'runner_example');
  assert.ok(!Object.hasOwn(username,'url'));
  assert.throws(()=>saveSportProfile(state,runner.id,garmin),/уже указан/u);
  assert.throws(()=>saveSportProfile(state,other.id,garmin),/уже указан/u);
  assert.throws(()=>saveSportProfile(state,runner.id,{...suunto,username:'https://example.com'}),/без ссылки/u);
  saveProfile(state,runner.id,{city:'Белград',telegram:'sample_client'});
  assert.equal(runner.profile.telegram,'sample_client');
  assert.deepEqual(cloudData(state).clients[runner.id].sportProfiles,[saved,username]);
  validateState(state);
  removeSportProfile(state,runner.id,username.id);
  removeSportProfile(state,runner.id,saved.id);
  assert.equal(runner.sportProfiles,undefined);
  validateState(state);
});

test('only the assigned coach or superadmin sees sports profiles',()=>{
  const state=emptyState(),coach=createClient(state,{name:'Тестовый тренер',role:'Тренер'});
  const runner=createClient(state,{name:'Тестовый клиент',coachId:coach.id});
  assert.equal(sportProfilesVisible(state,runner,{role:'coach',coachId:coach.id}),true);
  assert.equal(sportProfilesVisible(state,runner,{role:'coach',coachId:OWNER_COACH}),false);
  assert.equal(sportProfilesVisible(state,runner,{role:'superadmin'}),true);
  assert.equal(sportProfilesVisible(state,runner,{role:'athlete',athleteId:runner.id}),false);
  assert.equal(sportProfilesVisible(state,runner,{role:'accountant'}),false);
});
