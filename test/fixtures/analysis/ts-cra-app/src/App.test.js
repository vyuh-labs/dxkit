import { greeting } from './App';

test('greets by name', () => {
  expect(greeting('world')).toBe('Hello, world');
});
