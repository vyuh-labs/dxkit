// A @Serializable data class (extracted; String? gives real optionality)
// next to an unmarked helper (invisible).
package com.example

@Serializable
data class Item(
    val id: Int,
    val title: String,
    val note: String?,
)

class ItemIndexer {
    val entries: MutableMap<Int, String> = mutableMapOf()
}
