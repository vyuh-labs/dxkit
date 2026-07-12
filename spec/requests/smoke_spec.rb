describe 'smoke' do
  it 'gets' do
    get '/api/articles'
    post '/api/articles'
    get '/phantom/route'
  end
end
