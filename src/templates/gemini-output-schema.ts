/**
 * Gemini output schema for frame classification
 */
export const GEMINI_OUTPUT_SCHEMA = `{
  "video": {
    "filename": "string",
    "duration_sec": "number"
  },
  "products_detected": [
    {
      "product_id": "string",
      "description": "string",
      "product_category": "string"
    }
  ],
  "frame_evaluation": [
    {
      "frame_id": "string",
      "timestamp_sec": "number",
      "product_id": "string",
      "variant_id": "string",
      "angle_estimate": "string",
      "quality_score_0_100": "number",
      "similarity_note": "string",
      "rotation_angle_deg": "number (-45 to 45, angle to straighten product)",
      "obstructions": {
        "has_obstruction": "boolean",
        "obstruction_types": ["array"],
        "obstruction_description": "string or null",
        "removable_by_ai": "boolean"
      }
    }
  ],
  "variants_discovered": [
    {
      "product_id": "string",
      "variant_id": "string",
      "angle_estimate": "string",
      "description": "string",
      "best_frame_id": "string",
      "best_frame_score": "number",
      "rotation_angle_deg": "number (-45 to 45, angle to straighten product)",
      "all_frame_ids": ["array"],
      "obstructions": {
        "has_obstruction": "boolean",
        "obstruction_types": ["array"],
        "obstruction_description": "string or null",
        "removable_by_ai": "boolean"
      },
      "background_recommendations": {
        "solid_color": "string",
        "solid_color_name": "string",
        "real_life_setting": "string",
        "creative_shot": "string"
      }
    }
  ]
}`;
