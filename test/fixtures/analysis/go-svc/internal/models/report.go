package models

// A tagged struct (extracted - the tag IS the wire-contract marker) next to
// an untagged internal struct (invisible).
type Report struct {
	ID    int     `json:"id"`
	Title string  `json:"title"`
	Note  *string `json:"note,omitempty"`
}

type reportCache struct {
	entries map[int]string
}
