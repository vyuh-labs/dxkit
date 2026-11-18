import axios from 'axios';
export const listArticles = () => axios.get('/articles');
export const getArticle = (slug) => axios.get(`/articles/${slug}`);
export const createArticle = (d) => axios.post('/articles', d);
