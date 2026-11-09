export function microphoneState(value){
  if(!value||!['granted','prompt','prompt-with-rationale','denied','native-update-required'].includes(value.state))throw Error('Не удалось проверить доступ к микрофону');
  return {state:value.state,settingsRequired:value.state==='denied'};
}

export async function microphoneAccess(bridge){
  if(!bridge?.native)return {state:'browser',settingsRequired:false,openSettings:false};
  if(!bridge.microphonePermission||!bridge.requestMicrophonePermission)throw Error('Для доступа к микрофону установи новый APK 0.1.10 поверх приложения');
  const before=microphoneState(await bridge.microphonePermission());
  if(before.state==='native-update-required')throw Error('Для доступа к микрофону установи новый APK 0.1.10 поверх приложения');
  if(before.state==='granted')return {...before,openSettings:false};
  // Open settings only on a separate user action after a permanent denial.
  if(before.settingsRequired)return {...before,openSettings:true};
  return {...microphoneState(await bridge.requestMicrophonePermission()),openSettings:false};
}
