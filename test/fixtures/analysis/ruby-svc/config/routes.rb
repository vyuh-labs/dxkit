# Served surface: a resources expansion inside a namespace, plus an explicit
# verb with a to: binding — every form must sit inside the draw block to
# qualify (a bare `get '/x'` in a request spec never mints a route).
Rails.application.routes.draw do
  namespace :api do
    resources :articles, only: [:index, :create]
  end
  get '/health', to: 'status#health'
end
