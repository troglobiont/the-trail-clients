package io.github.troglobiont.trailclients;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

enum LauncherPalette {
    GRAPHITE("MainActivity"),
    COBALT("LauncherCobalt"),
    TERRACOTTA("LauncherTerracotta"),
    PLUM("LauncherPlum");

    private final String alias;

    LauncherPalette(String alias) {
        this.alias = alias;
    }

    static synchronized void apply(Context context, String palette) {
        LauncherPalette selected = valueOf(palette.toUpperCase(Locale.ROOT));
        PackageManager manager = context.getPackageManager();
        String packageName = context.getPackageName();
        List<ComponentName> toDisable = new ArrayList<>();
        ComponentName toEnable = null;

        for (LauncherPalette choice : values()) {
            ComponentName component = new ComponentName(packageName, packageName + "." + choice.alias);
            int setting = manager.getComponentEnabledSetting(component);
            boolean enabled = setting == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                    || (setting == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && choice == GRAPHITE);
            if (choice == selected && !enabled) toEnable = component;
            if (choice != selected && enabled) toDisable.add(component);
        }
        if (toEnable == null && toDisable.isEmpty()) return;

        int flags = PackageManager.DONT_KILL_APP;
        if (Build.VERSION.SDK_INT >= 33) {
            List<PackageManager.ComponentEnabledSetting> changes = new ArrayList<>();
            if (toEnable != null) {
                changes.add(new PackageManager.ComponentEnabledSetting(
                        toEnable, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, flags));
            }
            for (ComponentName component : toDisable) {
                changes.add(new PackageManager.ComponentEnabledSetting(
                        component, PackageManager.COMPONENT_ENABLED_STATE_DISABLED, flags));
            }
            manager.setComponentEnabledSettings(changes);
        } else {
            // Older Android versions must always have at least one enabled launcher entry.
            if (toEnable != null) {
                manager.setComponentEnabledSetting(toEnable, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, flags);
            }
            for (ComponentName component : toDisable) {
                manager.setComponentEnabledSetting(component, PackageManager.COMPONENT_ENABLED_STATE_DISABLED, flags);
            }
        }
    }
}
