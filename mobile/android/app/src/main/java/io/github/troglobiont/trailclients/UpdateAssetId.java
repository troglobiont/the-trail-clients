package io.github.troglobiont.trailclients;

/** JSON bridge numbers may be Integer, Long or Double. PluginCall.getLong
 * accepts only Long, so it cannot read ordinary GitHub asset IDs. */
public final class UpdateAssetId {
  private UpdateAssetId() {}
  public static long parse(Object raw) {
    if (!(raw instanceof Number)) throw new IllegalArgumentException("update-asset-id");
    Number number = (Number) raw;
    double value = number.doubleValue();
    long result = number.longValue();
    if (!Double.isFinite(value) || result < 1 || result > 9007199254740991L || value != (double) result) {
      throw new IllegalArgumentException("update-asset-id");
    }
    return result;
  }
}
