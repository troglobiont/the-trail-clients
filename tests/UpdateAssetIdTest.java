import io.github.troglobiont.trailclients.UpdateAssetId;

public final class UpdateAssetIdTest {
  public static void main(String[] args) {
    // Android org.json uses Integer for IDs below 2^31; larger IDs use Long.
    accepted(Integer.valueOf(727964925), 727964925L);
    accepted(Long.valueOf(3000000000L), 3000000000L);
    accepted(Double.valueOf(727964925), 727964925L);
    accepted(Long.valueOf(9007199254740991L), 9007199254740991L);
    for (Object value : new Object[] {null, "727964925", -1, 0, 1.5, Double.NaN,
        Double.POSITIVE_INFINITY, 9007199254740992L, Long.MAX_VALUE}) {
      try { UpdateAssetId.parse(value); }
      catch (IllegalArgumentException expected) { continue; }
      throw new AssertionError("Invalid asset ID accepted");
    }
    System.out.println("Native update asset ID regression checks passed.");
  }
  private static void accepted(Object value, long expected) {
    if (UpdateAssetId.parse(value) != expected) throw new AssertionError("Valid bridge number rejected");
  }
}
