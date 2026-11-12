package io.github.troglobiont.trailclients;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.*;

@CapacitorPlugin(name="TrailDevice", permissions={@Permission(alias="microphone", strings={Manifest.permission.RECORD_AUDIO})})
public class TrailDevicePlugin extends Plugin {
  private static final String REPO="https://api.github.com/repos/troglobiont/the-trail-clients";
  private static final int MAX_STORE=32*1024*1024;
  private final ExecutorService disk=Executors.newSingleThreadExecutor();
  private final ExecutorService network=Executors.newFixedThreadPool(2);
  private AtomicFile store(){return new AtomicFile(new File(getContext().getFilesDir(),"trail-clients-v1.json"));}
  private AtomicFile voice(){return new AtomicFile(new File(getContext().getFilesDir(),"trail-pending-voice.json"));}
  private interface Operation { JSObject run() throws Exception; }
  private void work(PluginCall call,Operation op){disk.execute(()->{try{call.resolve(op.run());}catch(Exception e){String m=e.getMessage();call.reject(m==null?"Операция не выполнена":m);}});}
  private void workNetwork(PluginCall call,Operation op){network.execute(()->{try{call.resolve(op.run());}catch(Exception e){String m=e.getMessage();call.reject(m==null?"Операция не выполнена":m);}});}
  @PluginMethod public void load(PluginCall call){work(call,()->{String text="";try(FileInputStream in=store().openRead()){text=new String(read(in,MAX_STORE),StandardCharsets.UTF_8);}catch(FileNotFoundException ignored){}return new JSObject().put("text",text);});}
  @PluginMethod public void loadInitialData(PluginCall call){work(call,()->{String text="";try(InputStream in=getContext().getAssets().open("trail-initial.client-data.json")){text=new String(read(in,MAX_STORE),StandardCharsets.UTF_8);}catch(FileNotFoundException ignored){}return new JSObject().put("text",text);});}
  @PluginMethod public void save(PluginCall call){work(call,()->{String text=call.getString("text","");byte[] bytes=text.getBytes(StandardCharsets.UTF_8);if(bytes.length>MAX_STORE)throw new IOException("База превышает 32 МБ; сохрани резервную копию");new JSONObject(text);AtomicFile file=store();FileOutputStream out=null;try{out=file.startWrite();out.write(bytes);file.finishWrite(out);}catch(Exception e){if(out!=null)file.failWrite(out);throw e;}return new JSObject().put("saved",true);});}
  @PluginMethod public void setLauncherPalette(PluginCall call) {
    work(call, () -> {
      LauncherPalette.apply(getContext(), call.getString("palette", ""));
      return new JSObject();
    });
  }
  @PluginMethod public void openTelegram(PluginCall call) {
    String peer = call.getString("peerId", "");
    String account = call.getString("accountPeerId", "");
    String username = call.getString("username", "");
    if (!peer.matches("[1-9][0-9]{0,18}") || !account.isEmpty() && !account.matches("[1-9][0-9]{0,18}")) {
      call.reject("Проверь привязку Telegram");return;
    }
    String direct = "tg://openmessage?user_id=" + peer + (account.isEmpty() ? "" : "&account_user_id=" + account);
    getActivity().runOnUiThread(() -> {
      // Use the ID only in official clients that implement openmessage.
      for (String app : new String[]{"org.telegram.messenger", "org.telegram.messenger.web", "org.telegram.messenger.beta"}) {
        try {
          getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(direct)).setPackage(app));
          call.resolve(new JSObject().put("opened", true));return;
        } catch (android.content.ActivityNotFoundException | SecurityException ignored) {}
      }
      if (username.matches("[A-Za-z][A-Za-z0-9_]{4,31}")) {
        try {
          getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("tg://resolve?domain=" + username)));
          call.resolve(new JSObject().put("opened", true));return;
        } catch (android.content.ActivityNotFoundException | SecurityException ignored) {}
      }
      call.reject("Не удалось открыть Telegram. Проверь, что Telegram установлен.");
    });
  }
  @PluginMethod public void loadVoice(PluginCall call){work(call,()->{String text="";try(FileInputStream in=voice().openRead()){text=new String(read(in,9*1024*1024),StandardCharsets.UTF_8);}catch(FileNotFoundException ignored){}return new JSObject().put("text",text);});}
  @PluginMethod public void saveVoice(PluginCall call){work(call,()->{String text=call.getString("text","");byte[] bytes=text.getBytes(StandardCharsets.UTF_8);if(bytes.length>9*1024*1024)throw new IOException("Запись слишком большая");new JSONObject(text);AtomicFile file=voice();FileOutputStream out=null;try{out=file.startWrite();out.write(bytes);file.finishWrite(out);}catch(Exception e){if(out!=null)file.failWrite(out);throw e;}return new JSObject().put("saved",true);});}
  @PluginMethod public void clearVoice(PluginCall call){work(call,()->{voice().delete();return new JSObject().put("cleared",true);});}
  private JSObject microphoneResult(){
    PermissionState state=getPermissionState("microphone");
    if(state==PermissionState.DENIED && getActivity().shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO))state=PermissionState.PROMPT_WITH_RATIONALE;
    return new JSObject().put("state",state.toString()).put("settingsRequired",state==PermissionState.DENIED);
  }
  @PluginMethod public void microphonePermission(PluginCall call){call.resolve(microphoneResult());}
  @PluginMethod public void requestMicrophonePermission(PluginCall call){
    if(getPermissionState("microphone")==PermissionState.GRANTED){call.resolve(microphoneResult());return;}
    requestPermissionForAlias("microphone",call,"microphonePermissionResult");
  }
  @PermissionCallback private void microphonePermissionResult(PluginCall call){if(call!=null)call.resolve(microphoneResult());}
  @PluginMethod public void openMicrophoneSettings(PluginCall call){
    getActivity().runOnUiThread(()->{try{
      Intent intent=new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getContext().getPackageName()));
      getActivity().startActivity(intent);call.resolve(new JSObject().put("opened",true));
    }catch(Exception e){call.reject("Не удалось открыть настройки приложения");}});
  }
  private synchronized SecretKey key() throws Exception {KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);String alias="trail-clients-secrets-v1";if(ks.containsAlias(alias))return ((KeyStore.SecretKeyEntry)ks.getEntry(alias,null)).getSecretKey();KeyGenerator gen=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");gen.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());return gen.generateKey();}
  private boolean validSecret(String name){return name.equals("githubToken")||name.equals("serviceToken")||name.equals("cloudSession");}
  private String secret(String name) throws Exception {String stored=getContext().getSharedPreferences("trail-vault",0).getString(name,"");if(stored.isEmpty())return "";String[] pieces=stored.split(":",2);Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(pieces[0],Base64.NO_WRAP)));return new String(c.doFinal(Base64.decode(pieces[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);}
  @PluginMethod public void setSecret(PluginCall call){work(call,()->{String name=call.getString("key","");if(!validSecret(name))throw new IOException("Неизвестный ключ");String value=call.getString("value","");if(value.length()>4096)throw new IOException("Ключ слишком длинный");String encrypted="";if(!value.isEmpty()){Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());encrypted=Base64.encodeToString(c.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(c.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);}boolean ok=getContext().getSharedPreferences("trail-vault",0).edit().putString(name,encrypted).commit();if(!ok)throw new IOException("Ключ не сохранён");return new JSObject().put("saved",true);});}
  @PluginMethod public void getSecret(PluginCall call){work(call,()->{String name=call.getString("key","");if(!validSecret(name))throw new IOException("Неизвестный ключ");return new JSObject().put("value",secret(name));});}
  private byte[] read(InputStream input,int max) throws IOException {ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buf=new byte[8192];int n;while((n=input.read(buf))!=-1){if(out.size()+n>max)throw new IOException("Ответ слишком большой");out.write(buf,0,n);}return out.toByteArray();}
  private HttpURLConnection github(String url,boolean binary) throws Exception {if(!url.startsWith(REPO+"/"))throw new IOException("Недопустимый адрес обновления");HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();c.setConnectTimeout(15000);c.setReadTimeout(30000);c.setInstanceFollowRedirects(false);c.setRequestProperty("Accept",binary?"application/octet-stream":"application/vnd.github+json");c.setRequestProperty("X-GitHub-Api-Version","2022-11-28");c.setRequestProperty("User-Agent","THE-TRAIL-Clients");String token=secret("githubToken");if(!token.isEmpty())c.setRequestProperty("Authorization","Bearer "+token);return c;}
  private boolean assetHost(URL url){return url.getProtocol().equals("https")&&(url.getHost().equals("release-assets.githubusercontent.com")||url.getHost().equals("objects.githubusercontent.com"))&&url.getUserInfo()==null;}
  private void checkGithubFailure(HttpURLConnection c,int code) throws IOException {if(code==401)throw new IOException("github-auth");if(code==403)throw new IOException("0".equals(c.getHeaderField("X-RateLimit-Remaining"))?"update-rate-limit":"update-forbidden");if(code==404)throw new IOException("release-missing");}
  private String githubText(String url,boolean asset) throws Exception {HttpURLConnection c=github(url,asset);try{int code=c.getResponseCode();checkGithubFailure(c,code);if(code==302||code==301){URL target=new URL(c.getHeaderField("Location"));if(!assetHost(target))throw new IOException("Недопустимый адрес архива");HttpURLConnection redirected=(HttpURLConnection)target.openConnection();redirected.setConnectTimeout(15000);redirected.setReadTimeout(30000);try{if(redirected.getResponseCode()!=200)throw new IOException("Не удалось прочитать выпуск");try(InputStream in=redirected.getInputStream()){return new String(read(in,256*1024),StandardCharsets.UTF_8);}}finally{redirected.disconnect();}}if(code!=200)throw new IOException("Не удалось прочитать выпуск");try(InputStream in=c.getInputStream()){return new String(read(in,256*1024),StandardCharsets.UTF_8);}}finally{c.disconnect();}}
  @PluginMethod public void readRelease(PluginCall call){workNetwork(call,()->{JSONObject release=new JSONObject(githubText(REPO+"/releases/latest",false));JSONArray assets=release.getJSONArray("assets");JSONObject manifest=null,bundle=null;for(int i=0;i<assets.length();i++){JSONObject a=assets.getJSONObject(i);if(a.getString("name").equals("version.json"))manifest=a;if(a.getString("name").equals("THE-TRAIL-Clients-update.zip"))bundle=a;}if(manifest==null||bundle==null)throw new IOException("release-missing");String text=githubText(REPO+"/releases/assets/"+manifest.getLong("id"),true);return new JSObject().put("manifest",text).put("assetId",bundle.getLong("id")).put("tag",release.getString("tag_name"));});}
  @PluginMethod public void resolveAsset(PluginCall call){workNetwork(call,()->{long asset=UpdateAssetId.parse(call.getData().opt("assetId"));HttpURLConnection c=github(REPO+"/releases/assets/"+asset,true);try{int code=c.getResponseCode();checkGithubFailure(c,code);if(code!=302&&code!=301)throw new IOException("update-asset-http-"+code);URL url=new URL(c.getHeaderField("Location"));if(!assetHost(url))throw new IOException("Недопустимый адрес архива");return new JSObject().put("url",url.toString());}finally{c.disconnect();}});}
  @PluginMethod public void requestService(PluginCall call){workNetwork(call,()->{String address=call.getString("url","");URL url=new URL(address);if(!url.getProtocol().equals("https")||url.getUserInfo()!=null)throw new IOException("Сервис должен использовать HTTPS");HttpURLConnection c=(HttpURLConnection)url.openConnection();c.setInstanceFollowRedirects(false);c.setConnectTimeout(15000);c.setReadTimeout(60000);String method=call.getString("method","GET");if(!method.equals("GET")&&!method.equals("POST"))throw new IOException("Недопустимая операция");c.setRequestMethod(method);c.setRequestProperty("Accept","application/json");c.setRequestProperty("Content-Type","application/json");String token=secret("serviceToken");if(!token.isEmpty())c.setRequestProperty("Authorization","Bearer "+token);String body=call.getString("body","");if(method.equals("POST")){byte[] bytes=body.getBytes(StandardCharsets.UTF_8);if(bytes.length>9*1024*1024)throw new IOException("Запись слишком большая");c.setDoOutput(true);try(OutputStream out=c.getOutputStream()){out.write(bytes);}}try{int code=c.getResponseCode();if(code<200||code>=300)throw new IOException(code==401?"Проверь ключ сервиса":"Сервис недоступен ("+code+")");try(InputStream in=c.getInputStream()){return new JSObject().put("body",new String(read(in,1024*1024),StandardCharsets.UTF_8));}}finally{c.disconnect();}});}
}
