package io.github.troglobiont.trailclients;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
  @Override public void onCreate(Bundle savedInstanceState) {
    registerPlugin(TrailDevicePlugin.class);
    super.onCreate(savedInstanceState);
  }
}
