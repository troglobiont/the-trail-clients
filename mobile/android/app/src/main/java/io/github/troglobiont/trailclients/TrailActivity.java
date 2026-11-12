package io.github.troglobiont.trailclients;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class TrailActivity extends BridgeActivity {
  @Override public void onCreate(Bundle savedInstanceState) {
    registerPlugin(TrailDevicePlugin.class);
    super.onCreate(savedInstanceState);
  }
}
