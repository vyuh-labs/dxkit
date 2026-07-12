# The ActiveRecord class is DISCOVERY only while db/schema.rb exists — the
# `articles` table entity carries the fields; minting `Article` too would
# give one logical model two identities.
class Article < ApplicationRecord
  attr_accessor :transient_flag
end
