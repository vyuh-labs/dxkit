# Consumed surface: trusted-constant HTTParty calls (one resolving each
# served article route) plus a runtime-built URL — recognized and DISCLOSED
# as dynamic, never silently dropped.
class BackendClient
  def list
    # Demo credential placeholder — the benign module must suppress it.
    password = 'password'
    HTTParty.get('/api/articles')
  end

  def create
    HTTParty.post('/api/articles')
  end

  def opaque(url)
    HTTParty.get(url)
  end
end
