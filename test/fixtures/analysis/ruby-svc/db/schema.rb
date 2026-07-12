# The Rails field source: create_table blocks are the authoritative model
# schema — the ActiveRecord class body declares no fields.
ActiveRecord::Schema[7.1].define(version: 2024_01_01_000000) do
  create_table "articles", force: :cascade do |t|
    t.string "title", null: false
    t.text "summary"
    t.datetime "created_at", null: false
    t.index ["title"], name: "index_articles_on_title"
  end
end
